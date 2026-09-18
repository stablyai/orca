import ExpoModulesCore
import WebKit

private let networkBlockIdentifier = "dev.orca.mobile-web-shell.network-block-v1"

/// Blocks every http(s) and ws(s) load beneath CSP, at the network layer. A nil compile result is a
/// fence we could not install, which is terminal: nothing loads.
private let networkBlockRules = """
  [
    { "trigger": { "url-filter": "^https?://" }, "action": { "type": "block" } },
    { "trigger": { "url-filter": "^wss?://" }, "action": { "type": "block" } }
  ]
  """

/// CSP is the fence for fetch and XMLHttpRequest. This script exists only for the two things a
/// native layer is never shown: a WebSocket handshake, which no request interceptor sees, and a
/// service worker registration. Kept in step with the Android copy. `configurable: false` with
/// `writable: false` is the only property shape the page cannot put back.
private let networkApiBlocker = """
  (function(){
  var deny=function(){throw new TypeError('Network access is disabled')};
  try{Object.defineProperty(globalThis,'WebSocket',{value:deny,configurable:false,writable:false})}catch(_){}
  try{Object.defineProperty(Navigator.prototype,'serviceWorker',{get:function(){return undefined},configurable:false})}catch(_){}
  try{Object.defineProperty(navigator,'serviceWorker',{value:undefined,configurable:false,writable:false})}catch(_){}
  })();
  """

private final class MobileWebShellSchemeHandler: NSObject, WKURLSchemeHandler {
  /// An asset is up to 10 MiB, and WebKit starts and stops scheme tasks on the main thread, so the
  /// read must not happen there.
  private let readQueue = DispatchQueue(label: "dev.orca.mobile-web-shell.read")
  /// Delivering to a task WebKit has already stopped raises an Objective-C exception Swift cannot
  /// catch, so a task is only touched while it is in this set. Main thread only.
  private var liveTasks: Set<ObjectIdentifier> = []

  var sessionId: String?
  var generation: MobileWebShellGeneration?

  func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
    let key = ObjectIdentifier(urlSchemeTask)
    liveTasks.insert(key)
    guard
      let sessionId,
      let generation,
      let url = urlSchemeTask.request.url,
      let parts = MobileWebShellRequestParts(request: urlSchemeTask.request),
      let path = MobileWebShellOrigin.resolveRequestPath(parts, sessionId: sessionId),
      let asset = generation.entries[path]
    else {
      fail(urlSchemeTask, key)
      return
    }
    readQueue.async { [weak self] in
      let data = try? Data(contentsOf: asset.file)
      DispatchQueue.main.async {
        guard let self, self.liveTasks.contains(key) else { return }
        guard
          let data,
          let response = Self.makeResponse(
            url: url,
            asset: asset,
            byteCount: data.count,
            path: path
          )
        else {
          self.fail(urlSchemeTask, key)
          return
        }
        self.liveTasks.remove(key)
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
      }
    }
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
    liveTasks.remove(ObjectIdentifier(urlSchemeTask))
  }

  private func fail(_ urlSchemeTask: WKURLSchemeTask, _ key: ObjectIdentifier) {
    guard liveTasks.remove(key) != nil else { return }
    urlSchemeTask.didFailWithError(URLError(.resourceUnavailable))
  }

  private static func makeResponse(
    url: URL,
    asset: MobileWebShellAsset,
    byteCount: Int,
    path: String
  ) -> HTTPURLResponse? {
    HTTPURLResponse(
      url: url,
      statusCode: 200,
      httpVersion: "HTTP/1.1",
      headerFields: MobileWebShellResponseHeaders.forPath(
        path,
        contentType: asset.contentType,
        byteCount: byteCount
      )
    )
  }
}

final class OrcaMobileWebShellView: ExpoView, WKNavigationDelegate, WKUIDelegate {
  let onLoadState = EventDispatcher()

  private let schemeHandler = MobileWebShellSchemeHandler()
  private var webView: WKWebView!
  private var generationDirectory = ""
  private var sessionId = ""
  private var appliedDirectory: String?
  private var appliedSessionId: String?
  private var pendingDocumentUrl: URL?
  private var isolationReady = false
  private var isolationFailed = false
  private let loadState = MobileWebShellLoadStateMachine()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    let configuration = WKWebViewConfiguration()
    // DOM storage and databases cannot be switched off on WebKit. A non-persistent store plus a
    // per-session origin plus destruction on unmount is the whole mitigation, and no isolation
    // claim here rests on them being absent.
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.setURLSchemeHandler(schemeHandler, forURLScheme: MobileWebShellOrigin.scheme)
    configuration.userContentController.addUserScript(
      WKUserScript(
        source: networkApiBlocker,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: false
      )
    )
    webView = WKWebView(frame: bounds, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(webView)
    NSLayoutConstraint.activate([
      webView.topAnchor.constraint(equalTo: topAnchor),
      webView.bottomAnchor.constraint(equalTo: bottomAnchor),
      webView.leadingAnchor.constraint(equalTo: leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: trailingAnchor)
    ])
    installNetworkBlock(into: configuration.userContentController)
  }

  func setGenerationDirectory(_ value: String) {
    generationDirectory = value
  }

  func setSessionId(_ value: String) {
    sessionId = value
  }

  /// Props arrive in no defined order, so neither setter starts anything; this does, once both are
  /// in. A repeat of the same pair is not a retry: a retry is a remount under a new React key.
  func propsDidUpdate() {
    guard generationDirectory != appliedDirectory || sessionId != appliedSessionId else { return }
    appliedDirectory = generationDirectory
    appliedSessionId = sessionId
    loadState.reset()
    pendingDocumentUrl = nil
    webView.stopLoading()
    webView.isHidden = false
    emit(loadState.started())
    guard
      MobileWebShellOrigin.isValidSessionId(sessionId),
      let documentUrl = MobileWebShellOrigin.documentUrl(sessionId: sessionId)
    else {
      // The private origin is the isolation primitive; a malformed session id leaves us without one.
      failPropUpdate(.isolationUnavailable)
      return
    }
    guard
      let generation = try? MobileWebShellGeneration.load(directoryPath: generationDirectory)
    else {
      failPropUpdate(.generationUnreadable)
      return
    }
    schemeHandler.sessionId = sessionId
    schemeHandler.generation = generation
    if isolationFailed {
      failPropUpdate(.isolationUnavailable)
      return
    }
    pendingDocumentUrl = documentUrl
    loadWhenIsolated()
  }

  /// The generation that failed to apply replaces whatever was on screen; leaving the previous one
  /// served and visible would show a page the caller has just been told is not loaded.
  private func failPropUpdate(_ reason: MobileWebShellFailureReason) {
    schemeHandler.sessionId = nil
    schemeHandler.generation = nil
    pendingDocumentUrl = nil
    webView.stopLoading()
    webView.isHidden = true
    emit(loadState.failed(reason))
  }

  private func installNetworkBlock(into controller: WKUserContentController) {
    guard let store = WKContentRuleListStore.default() else {
      // Optional-chaining past this ran no completion handler at all, so the view sat at `loading`
      // for the rest of its life. No store is no fence, which is the same terminal answer.
      isolationFailed = true
      pendingDocumentUrl = nil
      return
    }
    store.compileContentRuleList(
      forIdentifier: networkBlockIdentifier,
      encodedContentRuleList: networkBlockRules
    ) { [weak self] ruleList, _ in
      DispatchQueue.main.async {
        guard let self else { return }
        guard let ruleList else {
          self.isolationFailed = true
          self.pendingDocumentUrl = nil
          // Compiling is asynchronous, so this can land after the generation was already refused;
          // the state machine is what keeps that from being a second terminal reason.
          if self.appliedSessionId != nil {
            self.failPropUpdate(.isolationUnavailable)
          }
          return
        }
        controller.add(ruleList)
        self.isolationReady = true
        self.loadWhenIsolated()
      }
    }
  }

  private func loadWhenIsolated() {
    guard isolationReady, let url = pendingDocumentUrl else { return }
    pendingDocumentUrl = nil
    webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
  }

  private func emit(_ emission: MobileWebShellLoadEmission?) {
    guard let emission else { return }
    var payload: [String: Any] = ["state": emission.state]
    if let reason = emission.reason {
      payload["reason"] = reason
    }
    onLoadState(payload)
  }

  private func reportDocumentFailure() {
    emit(loadState.failed(.documentLoadFailed))
  }

  /// A cancelled navigation is our own doing, not the document's; see MobileWebShellNavigationError.
  private func reportNavigationFailure(_ error: Error) {
    let error = error as NSError
    guard !MobileWebShellNavigationError.isIgnorable(domain: error.domain, code: error.code) else {
      return
    }
    reportDocumentFailure()
  }

  private func isDocumentUrl(_ url: URL?) -> Bool {
    guard let url, let parts = MobileWebShellRequestParts(url: url) else { return false }
    return MobileWebShellOrigin.resolveRequestPath(parts, sessionId: sessionId) == "/"
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    if #available(iOS 14.5, *), navigationAction.shouldPerformDownload {
      decisionHandler(.cancel)
      return
    }
    let allowed = navigationAction.targetFrame?.isMainFrame == true &&
      isDocumentUrl(navigationAction.request.url)
    decisionHandler(allowed ? .allow : .cancel)
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationResponse: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    let allowed = navigationResponse.isForMainFrame &&
      navigationResponse.canShowMIMEType &&
      isDocumentUrl(navigationResponse.response.url)
    if !allowed {
      reportDocumentFailure()
    }
    decisionHandler(allowed ? .allow : .cancel)
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    guard appliedSessionId != nil else { return }
    emit(loadState.started())
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard isDocumentUrl(webView.url) else { return }
    emit(loadState.finished())
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    reportNavigationFailure(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    reportNavigationFailure(error)
  }

  /// Reported, never recovered from here. Renderer memory pressure and a WebView provider update
  /// look identical at this point, so the retry policy is the caller's and lives in one place.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    emit(loadState.failed(.renderProcessGone))
  }

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    nil
  }
}
