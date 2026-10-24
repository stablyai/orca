import ExpoModulesCore
import WebKit

/// React Native's handle on one page, which is built on the first prop commit.
final class OrcaMobileWebShellView: ExpoView, MobileWebShellPageSink {
  let onLoadState = EventDispatcher()
  let onBridgeMessage = EventDispatcher()
  let onExternalNavigation = EventDispatcher()

  private var generationDirectory = ""
  private var sessionId = ""
  private var bridgeEnabled = false
  private var page: MobileWebShellPage?

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
    let page = MobileWebShellPage()
    host(page.webView)
    page.sink = self
    return page
  }

  private func host(_ webView: WKWebView) {
    webView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(webView)
    NSLayoutConstraint.activate([
      webView.topAnchor.constraint(equalTo: topAnchor),
      webView.bottomAnchor.constraint(equalTo: bottomAnchor),
      webView.leadingAnchor.constraint(equalTo: leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: trailingAnchor)
    ])
  }

  func postBridgeMessage(_ json: String, promise: Promise) throws {
    guard let page else { throw MobileWebShellBridgeUnavailableException() }
    try page.postBridgeMessage(json, promise: promise)
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
