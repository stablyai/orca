// Why: Cloudflare Turnstile and similar bot detectors probe multiple browser
// APIs beyond navigator.webdriver. This script runs via
// Page.addScriptToEvaluateOnNewDocument before any page JS to mask automation
// signals that CDP debugger attachment and Electron's webview expose.
export const ANTI_DETECTION_SCRIPT = `(function() {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  // Why: Electron webviews expose an empty plugins array. Real Chrome always
  // has at least a few default plugins (PDF Viewer, etc.). An empty array is
  // a strong automation signal.
  if (navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' }
      ]
    });
  }
  // Why: Electron webviews may not have the window.chrome object that real
  // Chrome exposes. Turnstile checks for its presence. The csi() and
  // loadTimes() stubs satisfy deeper probes that check for these Chrome-
  // specific APIs beyond just chrome.runtime.
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {};
  }
  if (!window.chrome.csi) {
    window.chrome.csi = function() {
      return {
        startE: Date.now(),
        onloadT: Date.now(),
        pageT: performance.now(),
        tran: 15
      };
    };
  }
  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = function() {
      return {
        commitLoadTime: Date.now() / 1000,
        connectionInfo: 'h2',
        finishDocumentLoadTime: Date.now() / 1000,
        finishLoadTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: Date.now() / 1000,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'h2',
        requestTime: Date.now() / 1000 - 0.16,
        startLoadTime: Date.now() / 1000 - 0.3,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true
      };
    };
  }
  // Why: Electron's Permission API defaults to 'denied' for most permissions,
  // but real Chrome returns 'prompt' for ungranted permissions. Returning
  // 'denied' is a strong bot signal. Override the query result for common
  // permissions that Turnstile and similar detectors probe.
  const promptPerms = new Set([
    'notifications', 'geolocation', 'camera', 'microphone',
    'midi', 'idle-detection', 'storage-access'
  ]);
  const origQuery = Permissions.prototype.query;
  Permissions.prototype.query = function(desc) {
    if (promptPerms.has(desc.name)) {
      return Promise.resolve({ state: 'prompt', onchange: null });
    }
    return origQuery.call(this, desc);
  };
  // Why: Electron may report Notification.permission as 'denied' by default
  // whereas real Chrome reports 'default' for sites that haven't been granted
  // or blocked. Turnstile cross-references this with the Permissions API.
  try {
    Object.defineProperty(Notification, 'permission', {
      get: () => 'default'
    });
  } catch {}
  // Why: Electron webviews may have an empty languages array. Real Chrome
  // always has at least one entry. An empty array is an automation signal.
  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });
  }
})()`
