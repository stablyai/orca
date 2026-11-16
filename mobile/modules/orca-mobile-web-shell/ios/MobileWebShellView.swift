import ExpoModulesCore
import WebKit

/// Cancels loads while the host WebView is parked, and drops the slot if its process dies.
private final class ParkedNavigationDelegate: NSObject, WKNavigationDelegate {
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    decisionHandler(.cancel)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    OrcaMobileWebShellView.evictRetained(ifWebView: webView)
  }
}

/// One parked host document. The view that adopts it reattaches this WebView instead of booting another.
private final class RetainedMobileWebShellSlot {
  let applied: MobileWebShellAppliedProps
  let document: MobileWebShellDocument

  init(applied: MobileWebShellAppliedProps, document: MobileWebShellDocument) {
    self.applied = applied
    self.document = document
  }
}

/// React Native's handle on one document: it lays the WebView out and owns the back-edge swipe.
final class OrcaMobileWebShellView: ExpoView, MobileWebShellDocumentSink,
  UIGestureRecognizerDelegate {
  private static var retainedSlot: RetainedMobileWebShellSlot?
  private static let parkedDelegate = ParkedNavigationDelegate()
  private static let activeViews = NSHashTable<OrcaMobileWebShellView>.weakObjects()

  static func clearRetainedSlot() {
    guard let slot = retainedSlot else { return }
    retainedSlot = nil
    teardownSlot(slot)
  }

  static func evictRetained(ifWebView target: WKWebView) {
    guard let slot = retainedSlot, slot.document.webView === target else { return }
    retainedSlot = nil
    teardownSlot(slot)
  }

  private static func takeMatchingOrEvict(_ props: MobileWebShellAppliedProps) -> RetainedMobileWebShellSlot? {
    guard let slot = retainedSlot else { return nil }
    retainedSlot = nil
    if slot.applied.matches(props) {
      return slot
    }
    teardownSlot(slot)
    return nil
  }

  private static func retainSlot(_ slot: RetainedMobileWebShellSlot) {
    if let previous = retainedSlot, previous.document !== slot.document {
      teardownSlot(previous)
    }
    retainedSlot = slot
  }

  private static func teardownSlot(_ slot: RetainedMobileWebShellSlot) {
    let document = slot.document
    document.sink = nil
    document.webView.navigationDelegate = nil
    document.webView.uiDelegate = nil
    document.destroy()
  }

  /// The next host can mount before the previous view unmounts; park that document before taking it.
  private static func harvestRetiringView(
    requester: OrcaMobileWebShellView,
    target: MobileWebShellAppliedProps
  ) {
    guard
      let retiring = activeViews.allObjects.first(where: { view in
        view !== requester && view.document?.webView != nil && view.applied?.matches(target) == true
      })
    else { return }
    retiring.destroyWebView()
  }

  let onLoadState = EventDispatcher()
  let onBridgeMessage = EventDispatcher()
  let onExternalNavigation = EventDispatcher()
  let onBackEdgeSwipe = EventDispatcher()

  // The page's own Back: the stack's swipe is off while the page claims Back, and a strip overlay would eat taps.
  private let backEdgePan = UIPanGestureRecognizer()
  // Host page only. A child route must not take or replace the parked WebView.
  private var retainsSlot = true
  /// Taken on the first prop commit, not in init: the session id says whether a spare was booted for it.
  private var document: MobileWebShellDocument?
  private var generationDirectory = ""
  private var sessionId = ""
  private var bridgeEnabled = false
  private var applied: MobileWebShellAppliedProps?
  // The document does not expose commit; only a host that reached ready is worth parking.
  private var sawReady = false

  override func didMoveToWindow() {
    super.didMoveToWindow()
    document?.loadWhenIsolated()
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backEdgePan.isEnabled = false
    backEdgePan.addTarget(self, action: #selector(handleBackEdgePan(_:)))
    backEdgePan.delegate = self
    addGestureRecognizer(backEdgePan)
  }

  private func hostDocument() -> MobileWebShellDocument {
    let document = MobileWebShellSparePool.shared.document(for: sessionId, sink: self)
    attachWebView(document.webView)
    Self.activeViews.add(self)
    return document
  }

  func setBackEdgeSwipe(_ value: Bool) {
    backEdgePan.isEnabled = value
  }

  /// Only touches that start at the shell's left edge; a landscape safe area insets it from the screen's.
  func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    recognizer !== backEdgePan || touch.location(in: self).x <= 20
  }

  override func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
    guard recognizer === backEdgePan else { return super.gestureRecognizerShouldBegin(recognizer) }
    let velocity = backEdgePan.velocity(in: self)
    return velocity.x > abs(velocity.y)
  }

  /// Commit like the stack's own swipe: past half the width, or a rightward flick.
  @objc private func handleBackEdgePan(_ pan: UIPanGestureRecognizer) {
    guard pan.state == .ended else { return }
    let travel = pan.translation(in: self).x
    let speed = pan.velocity(in: self).x
    if speed > 300 || (speed > -300 && travel > bounds.width / 2) {
      onBackEdgeSwipe()
    }
  }

  private func attachWebView(_ target: WKWebView) {
    target.translatesAutoresizingMaskIntoConstraints = false
    addSubview(target)
    NSLayoutConstraint.activate([
      target.topAnchor.constraint(equalTo: topAnchor),
      target.bottomAnchor.constraint(equalTo: bottomAnchor),
      target.leadingAnchor.constraint(equalTo: leadingAnchor),
      target.trailingAnchor.constraint(equalTo: trailingAnchor)
    ])
    target.scrollView.panGestureRecognizer.require(toFail: backEdgePan)
  }

  /// Drop constraints that name this WebView so a parked instance can attach to the next host.
  private func detachWebView(_ webView: WKWebView) {
    if let host = webView.superview {
      NSLayoutConstraint.deactivate(host.constraints.filter { constraint in
        (constraint.firstItem as? UIView) === webView || (constraint.secondItem as? UIView) === webView
      })
    }
    webView.removeFromSuperview()
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

  func setRetainsSlot(_ value: Bool) {
    retainsSlot = value
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
    if document == nil {
      Self.harvestRetiringView(requester: self, target: next)
      if retainsSlot, let retained = Self.takeMatchingOrEvict(next), attachRetainedSlot(retained, next) {
        return
      }
      document = hostDocument()
    }
    applied = next
    document?.apply(
      generationDirectory: generationDirectory,
      sessionId: sessionId,
      bridgeEnabled: bridgeEnabled
    )
  }

  private func attachRetainedSlot(
    _ slot: RetainedMobileWebShellSlot,
    _ next: MobileWebShellAppliedProps
  ) -> Bool {
    let document = slot.document
    guard document.isUsable else {
      document.sink = nil
      document.destroy()
      return false
    }
    let webView = document.webView
    detachWebView(webView)
    webView.navigationDelegate = document
    webView.uiDelegate = document
    webView.isHidden = false
    document.sink = self
    self.document = document
    applied = next
    sawReady = true
    Self.activeViews.add(self)
    attachWebView(webView)
    onLoadState(["state": "loading"])
    onLoadState(["state": "ready"])
    return true
  }

  func destroyWebView() {
    Self.activeViews.remove(self)
    guard let current = document else { return }
    if retainsSlot, sawReady, current.isUsable, let currentApplied = applied {
      current.sink = nil
      let webView = current.webView
      webView.navigationDelegate = Self.parkedDelegate
      webView.uiDelegate = nil
      detachWebView(webView)
      document = nil
      applied = nil
      sawReady = false
      Self.retainSlot(RetainedMobileWebShellSlot(applied: currentApplied, document: current))
      return
    }
    current.sink = nil
    current.destroy()
    document = nil
    applied = nil
    sawReady = false
  }

  func postBridgeMessage(_ json: String, promise: Promise) throws {
    guard let document else { throw MobileWebShellBridgeUnavailableException() }
    try document.postBridgeMessage(json, promise: promise)
  }

  func documentLoadState(_ payload: [String: Any]) {
    switch payload["state"] as? String {
    case "loading", "failed":
      sawReady = false
    case "ready":
      sawReady = true
    default:
      break
    }
    onLoadState(payload)
  }

  func documentBridgeMessage(_ json: String) {
    onBridgeMessage(["json": json])
  }

  func documentExternalNavigation(_ url: String) {
    onExternalNavigation(["url": url])
  }
}
