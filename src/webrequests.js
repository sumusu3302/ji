const isFF = typeof browser !== "undefined";
if (!isFF) browser = chrome;

const hashingWorker = new Worker(browser.extension.getURL("src/hashing_worker.js"));

hashingWorker.onmessage = function(e) {
  if (e.data.action == "hash_found")
    notifyHashFound({ url: e.data.url });
}

// Enabling/Disabling the addon
var should_hash = false;

browser.storage.onChanged.addListener(changes => {
  let config = changes['config'].newValue;

  // Enabled ?
  should_hash = config.enabled;
  console.debug("hashing ?", should_hash);

  // Mode
  hashingWorker.postMessage({
    "action": "hashing_mode",

    "mode": config.mode
  });
});

class Request {
  static get(requestId, url) {
    if (requestId in Request.all)
      return Request.all[requestId];

    // The request does not exist yet
    let obj = new Request(requestId, url);
    Request.all[requestId] = obj;

    return obj;
  }

  // Hook
  static requestsHookFF(details) {
    if (!should_hash)
      return;

    let request = Request.get(details.requestId, details.url);

    let filter = browser.webRequest.filterResponseData(request.id);

    filter.ondata = event => {
      // A new data buffer has arrived !

      // Don't tamper with the data
      filter.write(event.data);

      // Transferts ownership of the data object to the Web Worker - so we must write the data before
      request.sendData(event.data);
    };

    filter.onstop = event => {
      // Cleanup all data associated with the request, and disconnect the filter
      request.cleanup();
      filter.disconnect();
    }

    filter.onerror = event => {
      request.cleanup();
    }
  }
  static requestsHookChrome(details) {
    if (!should_hash)
      return;

    // Chrome does not support reading the response data of requests ; we can only hash the url

    hashingWorker.postMessage({
      "action": "hash_single_url",

      "url": details.url
    });
  }

  static async hookAll() {
    // Is the add-on enabled ?
    let data = await Storage.retrieve('config');

    let mode = "most";
    if (data.config)??{
      should_hash = data.config.enabled;
      mode = data.config.mode;
    }
    else
      Storage.save({
        'config': {
          'mode': mode, 'enabled': should_hash
        }
      });

    console.debug("hashing ?", should_hash);
    hashingWorker.postMessage({
      "action": "hashing_mode",

      "mode": mode
    });

    // Requests
    if (isFF)
      Request.hookFF();
    else
      Request.hookChrome();
  }
  static hookFF() {
    browser.webRequest.onBeforeRequest.addListener(
      Request.requestsHookFF,

      // match any URL
      { urls: [ "<all_urls>" ] },
      ["blocking"]
    );
  }
  static hookChrome() {
    browser.webRequest.onBeforeRequest.addListener(
      Request.requestsHookChrome,

      // match any URL
      { urls: [ "<all_urls>" ] }
    );
  }

  constructor(requestId, url) {
    this.id = requestId;
    this.url = url;

    this.data_transfered = false;
  }
  sendData(data) {
    if (!this.data_transfered) {
      hashingWorker.postMessage({
        "action": "init_request",

        "requestId": this.id,
        "url": this.url
      });

      this.data_transfered = true;
    }

    // Transfers the object ownership to the Web Worker, instead of making a copy of it
    hashingWorker.postMessage({
      "action": "update_request",

      "requestId": this.id,
      "data": data
    }, [data]);
  }

  cleanup() {
    delete Request.all[this.id];

    if (!this.data_transfered)
      return;

    hashingWorker.postMessage({
      "action": "finalize_request",

      "requestId": this.id
    });
  }
}

// Static variables of Request
Request.all = {};
