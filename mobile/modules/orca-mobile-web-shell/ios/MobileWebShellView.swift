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

/// Installs `window.orcaBridge`, the whole page-facing surface: `postMessage(json)` and an
/// `onmessage` assignment. Android needs no counterpart because `addWebMessageListener` injects an
/// object of the same name and shape, so the contract is the intersection of the two.
///
/// CSP is untouched and the network blocker still runs: this is a second document-start script, not
/// a replacement. The sink is captured at install time so a page that deletes `window.webkit`
/// cannot take the channel with it, and every property is non-configurable and non-writable, the
/// only shape the page cannot put back.
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

/// The body of a `callAsyncJavaScript` call, with the payload bound to `m` as a real JS value, so no
/// reply content is ever parsed as script text.
///
/// Unguarded on purpose: a missing global is a page the installer never ran in, and throwing is what
/// rejects the host's promise. Checking for it would resolve a message nobody received.
private let bridgeDeliver = """
  globalThis.orcaBridge.__deliver(m)
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

/// `WKUserContentController` retains its message handlers, so the back-reference has to be weak or
/// the view outlives the React element that owned it.
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

/// Thrown rather than dropped: the only caller is the React Native host, and a silent drop would
/// turn a chunking bug there into a request that never settles.
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
    // DOM storage and databases cannot be switched off on WebKit. A non-persistent store plus a
    // per-session origin plus destruction on unmount is the whole mitigation, and no isolation
    // claim here rests on them being absent.
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    // WebKit's text interaction assistant wins the hold and raises its selection loupe, so the page
    // never sees a long press and every long-press action in it is dead (lane C1.7, measured).
    // Unguarded: the API is iOS 14.5+ and this target's floor is 15.1, so `#available` would be
    // dead code the compiler warns on.
    configuration.preferences.isTextInteractionEnabled = false
    configuration.setURLSchemeHandler(schemeHandler, forURLScheme: MobileWebShellOrigin.scheme)
    configuration.userContentController.addUserScript(Self.makeBlockerScript())
    bridgeReceiver.view = self
    webView = WKWebView(frame: bounds, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = false
    // Transparent, as the Android view is. A WKWebView is opaque by default and paints white
    // before its document does, so a dark app opening a page flashed white for the whole of the
    // page's boot; with no surface of its own, what shows through is the shell's own frame, which
    // is the one thing that knows the app's colours.
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.scrollView.backgroundColor = .clear
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

  func setBridgeEnabled(_ value: Bool) {
    bridgeEnabled = value
  }

  /// Props arrive in no defined order, so neither setter starts anything; this does, once both are
  /// in. A repeat of the same triple is not a retry: a retry is a remount under a new React key.
  /// `bridgeEnabled` is in the record because a document-start script only takes effect at the next
  /// document start: toggling it has to reload, or the prop would silently do nothing.
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

  /// The generation that failed to apply replaces whatever was on screen; leaving the previous one
  /// served and visible would show a page the caller has just been told is not loaded.
  private func failPropUpdate(_ reason: MobileWebShellFailureReason) {
    clearBridgeTarget()
    schemeHandler.sessionId = nil
    schemeHandler.generation = nil
    pendingDocumentUrl = nil
    webView.stopLoading()
    webView.isHidden = true
    emit(loadState.failed(reason))
  }

  /// Rebuilt per install rather than stored: `removeAllUserScripts` is the only removal WebKit has,
  /// so uninstalling the bridge means re-adding the blocker.
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
          // A convenience, not the fence: a subframe can reach a handler this never ran in, and
          // `accepts` is what refuses it.
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

  /// The session the page was loaded under, not the latest prop: a document served under the
  /// previous one is still alive until the next load commits, and it must not be heard.
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

  /// Settles on what WebKit did, not on what we handed it: a post into a dead renderer, a document
  /// that failed to load, a navigation still in flight or a page that has never spoken rejects here,
  /// and the delivery itself resolves only once the page has run it. Resolving any of those
  /// optimistically turns a request the RN host is waiting on into one that never settles.
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
    // Two `in:` labels is the real signature: `in frame:` and `in contentWorld:`. Naming the
    // completion handler is what picks it over the `async` overload. The frame is the one that
    // spoke, so the reply goes where the request came from rather than to the current main frame.
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
    // The only thing that tells the load the shell asked for from one a document asked for. The
    // state machine drops it again on every way a document can end.
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
    // `.linkActivated` is WebKit's own answer to "did a human start this". It decides only what may
    // be offered to the opener; nothing is allowed on the strength of it, because a subframe can
    // navigate the top frame with no gesture reported at all.
    let verdict = MobileWebShellNavigationPolicy.verdict(
      url: navigationAction.request.url?.absoluteString,
      isMainFrame: navigationAction.targetFrame?.isMainFrame == true,
      isFromSubframe: !navigationAction.sourceFrame.isMainFrame,
      isDocumentUrl: isDocumentUrl(navigationAction.request.url),
      isShellLoad: loadState.isShellLoad,
      hasGesture: navigationAction.navigationType == .linkActivated,
      isDownload: isDownload
    )
    if case let .cancelAndOffer(url) = verdict {
      onExternalNavigation(["url": url])
    }
    if verdict == .allow {
      // Spent here, before the decision is handed back: the next main-frame action gets no allow on
      // the strength of a load that has already been given one.
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
    // The document that spoke is being replaced, so it stops being somewhere to post and stops
    // being someone to hear: the next one has to commit, then say `ready`, which is what the
    // envelope has it do.
    clearBridgeTarget()
    loadState.documentEnded()
    guard appliedSessionId != nil else { return }
    emit(loadState.started())
  }

  /// The load the caller was told about is the one now on screen, so this is where the page becomes
  /// something to hear. Earlier than `didFinish`, because the page speaks at document start.
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    guard isDocumentUrl(webView.url) else { return }
    // Cleared here too, not only at the provisional start: arming is what this re-opens, so the
    // frame the replaced document spoke from must not be inheritable by the one replacing it.
    clearBridgeTarget()
    loadState.committed()
  }

  /// No URL check: the page rewrites its own path before its first render, so the document that
  /// committed at "/" finishes at the route it opened. `finished()` holds the rule that is left.
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

  /// Reported, never recovered from here. Renderer memory pressure and a WebView provider update
  /// look identical at this point, so the retry policy is the caller's and lives in one place.
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
