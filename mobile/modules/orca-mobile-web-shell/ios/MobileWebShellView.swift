import ExpoModulesCore
import WebKit

/// React Native's handle on one document: it lays the WebView out and owns the back-edge swipe.
final class OrcaMobileWebShellView: ExpoView, MobileWebShellDocumentSink,
  UIGestureRecognizerDelegate {
  let onLoadState = EventDispatcher()
  let onBridgeMessage = EventDispatcher()
  let onExternalNavigation = EventDispatcher()
  let onBackEdgeSwipe = EventDispatcher()

  // The page's own Back: the stack's swipe is off while the page claims Back, and a strip overlay would eat taps.
  private let backEdgePan = UIPanGestureRecognizer()
  /// Taken on the first prop commit, not in init: the session id says whether a spare was booted for it.
  private var document: MobileWebShellDocument?
  private var generationDirectory = ""
  private var sessionId = ""
  private var bridgeEnabled = false

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
    let webView = document.webView
    webView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(webView)
    NSLayoutConstraint.activate([
      webView.topAnchor.constraint(equalTo: topAnchor),
      webView.bottomAnchor.constraint(equalTo: bottomAnchor),
      webView.leadingAnchor.constraint(equalTo: leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: trailingAnchor)
    ])
    webView.scrollView.panGestureRecognizer.require(toFail: backEdgePan)
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

  func setGenerationDirectory(_ value: String) {
    generationDirectory = value
  }

  func setSessionId(_ value: String) {
    sessionId = value
  }

  func setBridgeEnabled(_ value: Bool) {
    bridgeEnabled = value
  }

  func propsDidUpdate() {
    let document = self.document ?? hostDocument()
    self.document = document
    document.apply(
      generationDirectory: generationDirectory,
      sessionId: sessionId,
      bridgeEnabled: bridgeEnabled
    )
  }

  func postBridgeMessage(_ json: String, promise: Promise) throws {
    guard let document else { throw MobileWebShellBridgeUnavailableException() }
    try document.postBridgeMessage(json, promise: promise)
  }

  func createVisualDocument(_ html: String) throws -> String {
    guard let document else { throw MobileWebShellBridgeUnavailableException() }
    return try document.createVisualDocument(html)
  }

  func releaseVisualDocument(_ url: String) {
    document?.releaseVisualDocument(url)
  }

  func documentLoadState(_ payload: [String: Any]) {
    onLoadState(payload)
  }

  func documentBridgeMessage(_ json: String) {
    onBridgeMessage(["json": json])
  }

  func documentExternalNavigation(_ url: String) {
    onExternalNavigation(["url": url])
  }
}
