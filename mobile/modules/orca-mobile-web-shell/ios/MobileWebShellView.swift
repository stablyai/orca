import ExpoModulesCore
import WebKit

private let networkBlockIdentifier = "dev.orca.mobile-web-shell.network-block-v1"

/// Block http(s)/ws(s) beneath CSP; compilation failure is terminal and must load nothing.
private let networkBlockRules = """
  [
    { "trigger": { "url-filter": "^https?://" }, "action": { "type": "block" } },
    { "trigger": { "url-filter": "^wss?://" }, "action": { "type": "block" } }
  ]
  """

/// CSP fences fetch/XHR; document-start script blocks unobservable WebSocket and service-worker APIs.
/// Match Android; both non-configurable and non-writable prevent page replacement.
private let networkApiBlocker = """
  (function(){
  var deny=function(){throw new TypeError('Network access is disabled')};
  try{Object.defineProperty(globalThis,'WebSocket',{value:deny,configurable:false,writable:false})}catch(_){}
  try{Object.defineProperty(Navigator.prototype,'serviceWorker',{get:function(){return undefined},configurable:false})}catch(_){}
  try{Object.defineProperty(navigator,'serviceWorker',{value:undefined,configurable:false,writable:false})}catch(_){}
  })();
  """

/// Inject the same orcaBridge surface as Android before scripts, alongside the network blocker.
/// Capture the sink so deleting window.webkit cannot break it; freeze properties against replacement.
private let bridgeInstaller = """
  (function(){
  var sink=window.webkit.messageHandlers.orcaBridge;
  var handler=null;
  var bridge={};
  Object.defineProperty(bridge,'postMessage',{value:function(json){
  if(typeof json!=='string'){throw new TypeError('orcaBridge.postMessage expects a string')}
  sink.postMessage(json)},configurable:false,writable:false,enumerable:true});
  Object.defineProperty(bridge,'onmessage',{get:function(){return handler},
  set:function(value){handler=typeof value==='function'?value:null},configurable:false,enumerable:true});
  Object.defineProperty(bridge,'__deliver',{value:function(json){if(handler){handler({data:json})}},
  configurable:false,writable:false,enumerable:false});
  Object.defineProperty(globalThis,'orcaBridge',{value:bridge,configurable:false,writable:false,enumerable:true});
  })();
  """

/// Bind payload as JS value m, never script text. A missing installer must throw to reject undelivered posts.
private let bridgeDeliver = """
  globalThis.orcaBridge.__deliver(m)
  """

private final class MobileWebShellSchemeHandler: NSObject, WKURLSchemeHandler {
  /// Read up-to-10-MiB assets off WebKit’s main-thread scheme callbacks.
  private let readQueue = DispatchQueue(label: "dev.orca.mobile-web-shell.read")
  /// Main-thread live-task set prevents stopped-task delivery’s uncatchable Objective-C exception.
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

/// WKUserContentController retains handlers; a weak view reference prevents a React-unmount leak.
private final class MobileWebShellBridgeReceiver: NSObject, WKScriptMessageHandler {
  weak var view: OrcaMobileWebShellView?

  func userContentController(
    _ controller: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    view?.receiveBridgeMessage(message)
  }
}

/// The RN host sees this, never the page: it is the difference between a request that failed and
/// one that never settles.
internal final class MobileWebShellBridgeDeliveryFailedException: GenericException<String>,
  @unchecked Sendable {
  override var reason: String {
    "The mobile web shell bridge could not deliver a message: \(param)"
  }
}

internal final class MobileWebShellBridgeUnavailableException: Exception, @unchecked Sendable {
  override var reason: String {
    "The mobile web shell bridge is not installed on this view"
  }
}

/// Throw so a host chunking bug rejects rather than leaving its request unsettled.
internal final class MobileWebShellBridgeMessageTooLargeException: GenericException<Int>,
  @unchecked Sendable {
  override var reason: String {
    "A bridge message of \(param) bytes exceeds the \(MobileWebShellBridge.maxMessageByteCount) byte cap"
  }
}

final class OrcaMobileWebShellView: ExpoView, WKNavigationDelegate, WKUIDelegate {
  let onLoadState = EventDispatcher()
  let onBridgeMessage = EventDispatcher()
  let onExternalNavigation = EventDispatcher()

  private let schemeHandler = MobileWebShellSchemeHandler()
  private let bridgeReceiver = MobileWebShellBridgeReceiver()
  private let bridgeGate = MobileWebShellBridgeGate()
  private var bridgeEnabled = false
  private var bridgeInstalled = false
  private var bridgeTarget = MobileWebShellBridgeTarget<WKFrameInfo>()
  private var webView: WKWebView!
  private var generationDirectory = ""
  private var sessionId = ""
  private var applied: MobileWebShellAppliedProps?
  private var appliedSessionId: String? { applied?.sessionId }
  private var pendingDocumentUrl: URL?
  private var isolationReady = false
  private var isolationFailed = false
  private let loadState = MobileWebShellLoadStateMachine()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    let configuration = WKWebViewConfiguration()
    configuration.allowsInlineMediaPlayback = true
    configuration.mediaTypesRequiringUserActionForPlayback = .all
    // WebKit cannot disable DOM storage/databases; isolate with a non-persistent store, per-session origin and unmount destruction.
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    // Disabling text interaction suppresses text after keydown; page user-select handles long-press selection.
    configuration.setURLSchemeHandler(schemeHandler, forURLScheme: MobileWebShellOrigin.scheme)
    configuration.userContentController.addUserScript(Self.makeBlockerScript())
    bridgeReceiver.view = self
    webView = WKWebView(frame: bounds, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = false
    // WKWebView’s opaque white default flashes during dark-page boot; transparency exposes the shell’s themed frame.
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.scrollView.backgroundColor = .clear
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    hideKeyboardAccessoryBar(of: webView)
    ignoreKeyboardNotifications(in: webView)
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

  func setBridgeEnabled(_ value: Bool) {
    bridgeEnabled = value
  }

  /// Apply unordered props together; identical triples do not retry (remount required).
  /// Include bridgeEnabled: document-start scripts require a reload to change.
  func propsDidUpdate() {
    let next = MobileWebShellAppliedProps(
      generationDirectory: generationDirectory,
      sessionId: sessionId,
      bridgeEnabled: bridgeEnabled
    )
    guard applied?.matches(next) != true else { return }
    applied = next
    clearBridgeTarget()
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
    applyBridgeInstallation()
    if isolationFailed {
      failPropUpdate(.isolationUnavailable)
      return
    }
    pendingDocumentUrl = documentUrl
    loadWhenIsolated()
  }

  /// Retire the old visible generation even when the replacement fails.
  private func failPropUpdate(_ reason: MobileWebShellFailureReason) {
    clearBridgeTarget()
    schemeHandler.sessionId = nil
    schemeHandler.generation = nil
    pendingDocumentUrl = nil
    webView.stopLoading()
    webView.isHidden = true
    emit(loadState.failed(reason))
  }

  /// removeAllUserScripts is WebKit’s only removal API, so disabling the bridge must reinstall the blocker.
  private static func makeBlockerScript() -> WKUserScript {
    WKUserScript(
      source: networkApiBlocker,
      injectionTime: .atDocumentStart,
      forMainFrameOnly: false
    )
  }

  /// Nothing here runs while the prop stays false, which is what keeps Phase B byte-identical.
  private func applyBridgeInstallation() {
    guard bridgeEnabled != bridgeInstalled else { return }
    clearBridgeTarget()
    let controller = webView.configuration.userContentController
    if bridgeEnabled {
      controller.add(bridgeReceiver, name: MobileWebShellBridge.handlerName)
      controller.addUserScript(
        WKUserScript(
          source: bridgeInstaller,
          injectionTime: .atDocumentStart,
          // Main-frame injection is convenience; accepts must still refuse subframes that reach the handler.
          forMainFrameOnly: true
        )
      )
    } else {
      controller.removeScriptMessageHandler(forName: MobileWebShellBridge.handlerName)
      controller.removeAllUserScripts()
      controller.addUserScript(Self.makeBlockerScript())
    }
    bridgeInstalled = bridgeEnabled
  }

  /// Use the loaded session, not latest props; the replaced same-origin document survives until commit.
  fileprivate func receiveBridgeMessage(_ message: WKScriptMessage) {
    guard bridgeInstalled, let json = message.body as? String else { return }
    let origin = message.frameInfo.securityOrigin
    let source = MobileWebShellBridgeSource(
      isOurWebView: message.webView === webView,
      isMainFrame: message.frameInfo.isMainFrame,
      hasCommittedDocument: loadState.hasCommittedDocument,
      originProtocol: origin.`protocol`,
      originHost: origin.host
    )
    guard
      MobileWebShellBridge.accepts(source, sessionId: appliedSessionId ?? ""),
      bridgeGate.accepts(byteCount: json.utf8.count)
    else { return }
    bridgeTarget.arm(frame: message.frameInfo, originHost: origin.host)
    onBridgeMessage(["json": json])
  }

  /// Anything that ends the document the page spoke from ends the only target native has.
  private func clearBridgeTarget() {
    bridgeTarget.clear()
  }

  /// Reject posts without a live committed frame that spoke; resolve only after page execution so host requests cannot hang.
  func postBridgeMessage(_ json: String, promise: Promise) throws {
    guard
      MobileWebShellBridge.canPost(
        toFrameOriginHost: bridgeTarget.originHost,
        sessionId: appliedSessionId ?? "",
        hasCommittedDocument: loadState.hasCommittedDocument
      ),
      let frame = bridgeTarget.frame
    else {
      throw MobileWebShellBridgeUnavailableException()
    }
    let byteCount = json.utf8.count
    guard MobileWebShellBridge.acceptsByteCount(byteCount) else {
      throw MobileWebShellBridgeMessageTooLargeException(byteCount)
    }
    // Use the two in: labels plus completionHandler to select the callback overload and reply to the frame that spoke.
    webView.callAsyncJavaScript(
      bridgeDeliver,
      arguments: ["m": json],
      in: frame,
      in: .page
    ) { result in
      switch result {
      case .success:
        promise.resolve()
      case .failure(let error):
        promise.reject(MobileWebShellBridgeDeliveryFailedException(error.localizedDescription))
      }
    }
  }

  private func installNetworkBlock(into controller: WKUserContentController) {
    guard let store = WKContentRuleListStore.default() else {
      // Optional chaining skips completion when the store is absent, leaving loading forever; fail closed instead.
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
          // Rule compilation can finish after refusal; the state machine prevents a second terminal reason.
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
    // Only our own load raises this flag; every document ending clears it.
    loadState.shellLoadStarted()
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
    clearBridgeTarget()
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
    var isDownload = false
    if #available(iOS 14.5, *) {
      isDownload = navigationAction.shouldPerformDownload
    }
    // linkActivated gates only opener offers; gesture-free subframe top navigation must never authorize a load.
    let verdict = MobileWebShellNavigationPolicy.verdict(
      url: navigationAction.request.url?.absoluteString,
      isMainFrame: navigationAction.targetFrame?.isMainFrame == true,
      isDocumentUrl: isDocumentUrl(navigationAction.request.url),
      isShellLoad: loadState.isShellLoad,
      hasGesture: navigationAction.navigationType == .linkActivated,
      isDownload: isDownload
    )
    if case let .cancelAndOffer(url) = verdict {
      onExternalNavigation(["url": url])
    }
    if verdict == .allow {
      // Spend before handing back the decision so another main-frame action cannot reuse the allowance.
      loadState.shellLoadConsumed()
    }
    decisionHandler(verdict == .allow ? .allow : .cancel)
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
    // Clear replies and acceptance when the document is replaced; its successor must commit and send ready.
    clearBridgeTarget()
    loadState.documentEnded()
    guard appliedSessionId != nil else { return }
    emit(loadState.started())
  }

  /// Arm at commit, before document-start messages and didFinish.
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    guard isDocumentUrl(webView.url) else { return }
    // Commit rearms acceptance, so clear the replaced frame here as well as at provisional start.
    clearBridgeTarget()
    loadState.committed()
  }

  /// history.replaceState changes the path before finish; finished() uses commit state instead of URL equality.
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
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

  /// Report renderer death; memory pressure/provider updates look alike, so the caller owns retry policy.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    clearBridgeTarget()
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
