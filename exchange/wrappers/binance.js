const moment = require('moment');
const _ = require('lodash');

const Errors = require('../exchangeErrors');
const marketData = require('./binance-markets.json');
const retry = require('../exchangeUtils').retry;

const Binance = require('binance');

var Trader = function(config) {
  _.bindAll(this);

  if (_.isObject(config)) {
    this.key = config.key;
    this.secret = config.secret;
    this.currency = config.currency.toUpperCase();
    this.asset = config.asset.toUpperCase();
  }

  this.pair = this.asset + this.currency;
  this.name = 'binance';

  this.market = _.find(Trader.getCapabilities().markets, (market) => {
    return market.pair[0] === this.currency && market.pair[1] === this.asset
  });

  this.binance = new Binance.BinanceRest({
    key: this.key,
    secret: this.secret,
    timeout: 15000,
    recvWindow: 60000, // suggested by binance
    disableBeautification: false,
    handleDrift: true,
  });
};

var retryCritical = {
  retries: 10,
  factor: 1.2,
  minTimeout: 1 * 1000,
  maxTimeout: 30 * 1000
};

var retryForever = {
  forever: true,
  factor: 1.2,
  minTimeout: 10 * 1000,
  maxTimeout: 30 * 1000
};

var recoverableErrors = new RegExp(/(SOCKETTIMEDOUT|TIMEDOUT|CONNRESET|CONNREFUSED|NOTFOUND|Error -1021|Response code 429|Response code 5)/);

Trader.prototype.processError = function(funcName, error) {
  if (!error) return undefined;

  if (!error.message || !error.message.match(recoverableErrors)) {
    return new Errors.AbortError('[binance.js] ' + error.message || error);
  }

  return new Errors.RetryError('[binance.js] ' + error.message || error);
};

Trader.prototype.handleResponse = function(funcName, callback) {
  return (error, body) => {
    if (body && body.code) {
      error = new Error(`Error ${body.code}: ${body.msg}`);
    }

    return callback(this.processError(funcName, error), body);
  }
};

Trader.prototype.getTrades = function(since, callback, descending) {
  var processResults = function(err, data) {
    if (err) return callback(err);

    var parsedTrades = [];
    _.each(
      data,
      function(trade) {
        parsedTrades.push({
          tid: trade.aggTradeId,
          date: moment(trade.timestamp).unix(),
          price: parseFloat(trade.price),
          amount: parseFloat(trade.quantity),
        });
      },
      this
    );

    if (descending) callback(null, parsedTrades.reverse());
    else callback(undefined, parsedTrades);
  };

  var reqData = {
    symbol: this.pair,
  };

  if (since) {
    var endTs = moment(since)
      .add(1, 'h')
      .valueOf();
    var nowTs = moment().valueOf();

    reqData.startTime = moment(since).valueOf();
    reqData.endTime = endTs > nowTs ? nowTs : endTs;
  }

  let handler = (cb) => this.binance.aggTrades(reqData, this.handleResponse('getTrades', cb));
  retry(retryForever, _.bind(handler, this), _.bind(processResults, this));
};

Trader.prototype.getPortfolio = function(callback) {
  const setBalance = (err, data) => {
    if (err) return callback(err);

    const findAsset = item => item.asset === this.asset;
    const assetAmount = parseFloat(_.find(data.balances, findAsset).free);

    const findCurrency = item => item.asset === this.currency;
    const currencyAmount = parseFloat(_.find(data.balances, findCurrency).free);

    if (!_.isNumber(assetAmount) || _.isNaN(assetAmount)) {
      assetAmount = 0;
    }

    if (!_.isNumber(currencyAmount) || _.isNaN(currencyAmount)) {
      currencyAmount = 0;
    }

    const portfolio = [
      { name: this.asset, amount: assetAmount },
      { name: this.currency, amount: currencyAmount },
    ];

    return callback(undefined, portfolio);
  };

  const fetch = cb => this.binance.account({}, this.handleResponse('getPortfolio', cb));
  retry(retryForever, fetch, setBalance);
};

// This uses the base maker fee (0.1%), and does not account for BNB discounts
Trader.prototype.getFee = function(callback) {
  const makerFee = 0.1;
  callback(undefined, makerFee / 100);
};

Trader.prototype.getTicker = function(callback) {
  const setTicker = (err, data) => {
    if (err)
      return callback(err);

    var result = _.find(data, ticker => ticker.symbol === this.pair);

    if(!result)
      return callback(new Error(`Market ${this.pair} not found on Binance`));

    var ticker = {
      ask: parseFloat(result.askPrice),
      bid: parseFloat(result.bidPrice),
    };

    callback(undefined, ticker);
  };

  const handler = cb => this.binance._makeRequest({}, this.handleResponse('getTicker', cb), 'api/v1/ticker/allBookTickers');
  retry(retryForever, handler, setTicker);
};

// Effectively counts the number of decimal places, so 0.001 or 0.234 results in 3
Trader.prototype.getPrecision = function(tickSize) {
  if (!isFinite(tickSize)) return 0;
  var e = 1, p = 0;
  while (Math.round(tickSize * e) / e !== tickSize) { e *= 10; p++; }
  return p;
};

Trader.prototype.round = function(amount, tickSize) {
  var precision = 100000000;
  var t = this.getPrecision(tickSize);

  if(Number.isInteger(t))
    precision = Math.pow(10, t);

  amount *= precision;
  amount = Math.floor(amount);
  amount /= precision;
  return amount;
};

Trader.prototype.roundAmount = function(amount) {
  return this.round(amount, this.market.minimalOrder.amount);
}

Trader.prototype.roundPrice = function(price) {
  return this.round(price, this.market.minimalOrder.price);
}

Trader.prototype.isValidPrice = function(price) {
  return price >= this.market.minimalOrder.price;
}

Trader.prototype.isValidLot = function(price, amount) {
  return amount * price >= this.market.minimalOrder.order;
}

Trader.prototype.addOrder = function(tradeType, amount, price, callback) {
  const setOrder = (err, data) => {
    if (err) return callback(err);

    const txid = data.orderId;

    callback(undefined, txid);
  };

  const reqData = {
    symbol: this.pair,
    side: tradeType.toUpperCase(),
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: amount,
    price: price,
    timestamp: new Date().getTime()
  };

  const handler = cb => this.binance.newOrder(reqData, this.handleResponse('addOrder', cb));
  retry(retryCritical, handler, setOrder);
};

Trader.prototype.getOrder = function(order, callback) {
  const get = (err, data) => {
    if (err) return callback(err);

    const trade = _.find(data, t => {
      // note: the API returns a string after creating
      return t.orderId == order;
    });

    if(!trade) {
      return callback(new Error('Trade not found'));
    }

    const price = parseFloat(trade.price);
    const amount = parseFloat(trade.qty);
    
    // Data.time is a 13 digit millisecond unix time stamp.
    // https://momentjs.com/docs/#/parsing/unix-timestamp-milliseconds/ 
    const date = moment(trade.time);

    const fees = {
      [trade.commissionAsset]: +trade.commission
    }

    callback(undefined, { price, amount, date, fees });
  }

  const reqData = {
    symbol: this.pair,
    // if this order was not part of the last 500 trades we won't find it..
    limit: 500,
  };

  const handler = cb => this.binance.myTrades(reqData, this.handleResponse('getOrder', cb));
  retry(retryCritical, handler, get);
};

Trader.prototype.buy = function(amount, price, callback) {
  this.addOrder('buy', amount, price, callback);
};

Trader.prototype.sell = function(amount, price, callback) {
  this.addOrder('sell', amount, price, callback);
};

Trader.prototype.checkOrder = function(order, callback) {

  const check = (err, data) => {
    if (err) return callback(err);

    const status = data.status;

    if(
      status === 'CANCELED' ||
      status === 'REJECTED' ||
      // for good measure: GB does not
      // submit orders that can expire yet
      status === 'EXPIRED'
    ) {
      return callback(undefined, { executed: false, open: false });
    } else if(
      status === 'NEW' ||
      status === 'PARTIALLY_FILLED'
    ) {
      return callback(undefined, { executed: false, open: true, filledAmount: +data.executedQty });
    } else if(status === 'FILLED') {
      return callback(undefined, { executed: true, open: false })
    }

    console.log('what status?', status);
    throw status;
  };

  const reqData = {
    symbol: this.pair,
    orderId: order,
  };

  const fetcher = cb => this.binance.queryOrder(reqData, this.handleResponse('checkOrder', cb));
  retry(retryCritical, fetcher, check);
};

Trader.prototype.cancelOrder = function(order, callback) {
  // callback for cancelOrder should be true if the order was already filled, otherwise false
  const cancel = (err, data) => {
    if (err) {
      if(data && data.msg === 'UNKNOWN_ORDER') {  // this seems to be the response we get when an order was filled
        return callback(undefined, true); // tell the thing the order was already filled
      }
      return callback(err);
    }
    callback(undefined, false);
  };

  let reqData = {
    symbol: this.pair,
    orderId: order,
  };

  const fetcher = cb => this.binance.cancelOrder(reqData, this.handleResponse('cancelOrder', cb));
  retry(retryForever, fetcher, cancel);
};

Trader.prototype.initMarkets = function(callback) {

}

Trader.getCapabilities = function() {
  return {
    name: 'Binance',
    slug: 'binance',
    currencies: marketData.currencies,
    assets: marketData.assets,
    markets: marketData.markets,
    requires: ['key', 'secret'],
    providesHistory: 'date',
    providesFullHistory: true,
    tid: 'tid',
    tradable: true
  };
};

module.exports = Trader;