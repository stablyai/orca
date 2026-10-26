import UIKit
import WebKit

/// The first page view in a process waits for WebKit to launch its helper processes. A blank view
/// loaded while Home is idle pays that instead. It is held until the first page has loaded, so that
/// page starts against processes already up, or until the app backgrounds, memory runs low or a
/// minute passes. It has its own non-persistent store and no bridge or scripts, so it shares no
/// state with a page.
enum MobileWebShellWarmUp {
  private static var view: WKWebView?
  private static var started = false
  private static var observers: [NSObjectProtocol] = []

  static func start() {
    dispatchPrecondition(condition: .onQueue(.main))
    // A launch into the background may never show a page, so it gets no web process.
    guard !started, UIApplication.shared.applicationState == .active else { return }
    started = true
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.loadHTMLString("", baseURL: nil)
    self.view = view
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) { release() }
    observers = [
      UIApplication.didReceiveMemoryWarningNotification,
      UIApplication.didEnterBackgroundNotification
    ].map { name in
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in release() }
    }
  }

  static func release() {
    dispatchPrecondition(condition: .onQueue(.main))
    view = nil
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers = []
  }
}
