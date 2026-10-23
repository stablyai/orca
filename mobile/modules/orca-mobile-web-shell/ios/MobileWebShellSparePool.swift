import UIKit
import WebKit

/// How long a taken spare waits for the view that asked for it before it is destroyed.
private let claimExpirySeconds: TimeInterval = 10

/// Holds what a parked page says until a view adopts it, then hands it over in order: the load
/// states, so the session sees the same loading-then-ready it sees from a fresh view, and the page's
/// last `ready`, which it may otherwise not repeat for two seconds.
final class MobileWebShellParkedSink: MobileWebShellPageSink {
  private var loadStates: [[String: Any]] = []
  private(set) var lastFrame: String?

  func pageLoadState(_ payload: [String: Any]) {
    loadStates.append(payload)
  }

  func pageBridgeMessage(_ json: String) {
    lastFrame = json
  }

  /// A parked page has no screen to have been tapped on.
  func pageExternalNavigation(_ url: String) {}

  func replay(into sink: MobileWebShellPageSink) {
    loadStates.forEach(sink.pageLoadState)
    if let lastFrame {
      sink.pageBridgeMessage(lastFrame)
    }
  }
}

final class MobileWebShellSpare: MobileWebShellSparePage {
  let page: MobileWebShellPage
  let parked: MobileWebShellParkedSink

  init(page: MobileWebShellPage, parked: MobileWebShellParkedSink) {
    self.page = page
    self.parked = parked
  }

  var isUsable: Bool { page.isUsable }

  func destroy() {
    page.destroy()
  }
}

/// One page booted ahead of the screen that will show it, app-wide. Main thread only.
///
/// Parked in the key window beneath everything else rather than off-window: WebKit treats an
/// off-window view as hidden and does not start its GPU process until the first one is shown, which
/// stalled a first open by about 1.8 s on the simulator. Touches and accessibility are off until a
/// view adopts it.
final class MobileWebShellSparePool {
  static let shared = MobileWebShellSparePool()

  private let slots = MobileWebShellSpareSlots<MobileWebShellSpare>()

  func prepare(hostKey: String, directory: String, sessionId: String) {
    guard slots.wants(hostKey: hostKey, directory: directory) else { return }
    slots.park(hostKey: hostKey, directory: directory, sessionId: sessionId) {
      let page = MobileWebShellPage()
      let sink = MobileWebShellParkedSink()
      page.sink = sink
      park(page.webView)
      page.apply(generationDirectory: directory, sessionId: sessionId, bridgeEnabled: true)
      return MobileWebShellSpare(page: page, parked: sink)
    }
  }

  /// The spare's session id when it was booted from `directory` and is still alive.
  func take(hostKey: String, directory: String) -> String? {
    guard let sessionId = slots.take(hostKey: hostKey, directory: directory)?.sessionId else {
      return nil
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + claimExpirySeconds) { [weak self] in
      self?.slots.expire(sessionId: sessionId)
    }
    return sessionId
  }

  func adopt(sessionId: String) -> MobileWebShellSpare? {
    slots.adopt(sessionId: sessionId)?.page
  }

  func reserve(sessionId: String) -> Bool {
    slots.reserve(sessionId: sessionId)
  }

  func discard(hostKey: String?) {
    slots.discard(hostKey: hostKey)
  }

  func discardAll() {
    slots.discardAll()
  }

  private func park(_ webView: WKWebView) {
    webView.isUserInteractionEnabled = false
    webView.accessibilityElementsHidden = true
    let window = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)
    guard let window else { return }
    webView.translatesAutoresizingMaskIntoConstraints = true
    webView.frame = window.bounds
    window.insertSubview(webView, at: 0)
  }
}
