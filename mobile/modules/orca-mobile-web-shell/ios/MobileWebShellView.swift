import ExpoModulesCore
import WebKit

/// React Native's handle on one page. The page is built on the first prop commit rather than in
/// `init`, because that is when the session id says whether a spare was booted for it.
final class OrcaMobileWebShellView: ExpoView, MobileWebShellPageSink {
  let onLoadState = EventDispatcher()
  let onBridgeMessage = EventDispatcher()
  let onExternalNavigation = EventDispatcher()

  private var generationDirectory = ""
  private var sessionId = ""
  private var bridgeEnabled = false
  private var page: MobileWebShellPage?
  /// The adopted spare's `ready`, kept until the shell first speaks to the page: the host that
  /// answers it can be built after the adoption replayed it into nothing.
  private var adoptedReady: String?

  func setGenerationDirectory(_ value: String) {
    generationDirectory = value
  }

  func setSessionId(_ value: String) {
    sessionId = value
  }

  func setBridgeEnabled(_ value: Bool) {
    bridgeEnabled = value
  }

  /// Props arrive in no defined order, so no setter starts anything; this does, once all are in.
  func propsDidUpdate() {
    let current = page ?? hostPage()
    page = current
    current.apply(
      generationDirectory: generationDirectory,
      sessionId: sessionId,
      bridgeEnabled: bridgeEnabled
    )
  }

  private func hostPage() -> MobileWebShellPage {
    let pool = MobileWebShellSparePool.shared
    let spare = pool.adopt(sessionId: sessionId)
    // An id the pool issued whose page is gone must not get a second WebView; the page reports a
    // dead content process, and the remount mints a fresh id.
    let page = spare?.page ?? MobileWebShellPage(dead: !pool.reserve(sessionId: sessionId))
    host(page.webView)
    page.sink = self
    if let spare {
      spare.parked.replay(into: self)
      adoptedReady = spare.parked.lastFrame
    }
    return page
  }

  private func host(_ webView: WKWebView) {
    webView.removeFromSuperview()
    webView.isUserInteractionEnabled = true
    webView.accessibilityElementsHidden = false
    webView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(webView)
    NSLayoutConstraint.activate([
      webView.topAnchor.constraint(equalTo: topAnchor),
      webView.bottomAnchor.constraint(equalTo: bottomAnchor),
      webView.leadingAnchor.constraint(equalTo: leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: trailingAnchor)
    ])
  }

  /// Hands the adopted spare's `ready` to the shell again, until the shell has answered it.
  func replayPageReady() {
    if let adoptedReady {
      pageBridgeMessage(adoptedReady)
    }
  }

  func postBridgeMessage(_ json: String, promise: Promise) throws {
    guard let page else { throw MobileWebShellBridgeUnavailableException() }
    try page.postBridgeMessage(json, promise: promise)
    adoptedReady = nil
  }

  func pageLoadState(_ payload: [String: Any]) {
    onLoadState(payload)
  }

  func pageBridgeMessage(_ json: String) {
    onBridgeMessage(["json": json])
  }

  func pageExternalNavigation(_ url: String) {
    onExternalNavigation(["url": url])
  }
}
