import UIKit
import WebKit

/// More than 3 GiB can only come from a phone with 4 GB or more; those report about 3.5 to 3.9 GiB.
private let minimumPhysicalMemory: UInt64 = 3 << 30

/// A claim is adopted on the claiming screen's first commit; this only bounds a screen that never mounts.
private let claimExpirySeconds: TimeInterval = 10

/// iOS has no "memory is low" to ask before booting (Android's `lowMemory`), and pressure outlasts its warning.
private let memoryWarningBackoffSeconds: TimeInterval = 180

/// A booted document waiting for a screen. It keeps what the page reported, and the page's ready, for
/// the view that adopts it: a parked page stops asking for init, so its ready is answered from here.
final class MobileWebShellSpare: MobileWebShellDocumentSink {
  let document = MobileWebShellDocument()
  let directory: String
  let sessionId: String
  private var loadStates: [[String: Any]] = []
  private var ready: String?

  init(directory: String, sessionId: String) {
    self.directory = directory
    self.sessionId = sessionId
    document.sink = self
  }

  func documentLoadState(_ payload: [String: Any]) {
    loadStates.append(payload)
    if payload["state"] as? String == "failed" {
      MobileWebShellSparePool.shared.discard(self)
    }
  }

  /// Before init a page only sends ready, from its first document or one it reloaded.
  func documentBridgeMessage(_ json: String) {
    ready = json
    document.postHostFrame(MobileWebShellBridge.parkedFrame)
  }

  /// A parked page has no screen to have been tapped on.
  func documentExternalNavigation(_ url: String) {}

  /// The adopting view sees what a fresh document would have reported, ready last.
  func handOver(to sink: MobileWebShellDocumentSink) {
    document.sink = sink
    loadStates.forEach(sink.documentLoadState)
    if let ready {
      sink.documentBridgeMessage(ready)
    }
  }
}

/// At most one document booted ahead of its screen, only while no page document is shown. Main thread only.
/// Parked in the key window at alpha 0: WebKit suspends an off-window view (0.5–1.3 s to paint after 30 s, vs 0.1 s).
final class MobileWebShellSparePool {
  static let shared = MobileWebShellSparePool()

  private var parked: MobileWebShellSpare?
  private var claimed: MobileWebShellSpare?
  private let shown = NSHashTable<MobileWebShellDocument>.weakObjects()
  private var memoryWarningUptime: TimeInterval?

  /// Whether a spare for `directory` is parked after the call; never on a small phone, inactive app or shown
  /// page, nor soon after a memory warning.
  func prepare(directory: String, sessionId: String) -> Bool {
    guard
      ProcessInfo.processInfo.physicalMemory > minimumPhysicalMemory,
      !recentlyWarnedAboutMemory(),
      UIApplication.shared.applicationState == .active,
      shown.allObjects.isEmpty,
      let window = keyWindow()
    else { return false }
    if let parked, parked.directory == directory, parked.document.isUsable {
      return true
    }
    // A claim no view adopted was abandoned; it must not outlive the spare that replaces it.
    discardAll()
    let spare = MobileWebShellSpare(directory: directory, sessionId: sessionId)
    let webView = spare.document.webView
    webView.alpha = 0
    webView.isUserInteractionEnabled = false
    webView.accessibilityElementsHidden = true
    webView.frame = window.bounds
    webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    window.insertSubview(webView, at: 0)
    parked = spare
    spare.document.apply(generationDirectory: directory, sessionId: sessionId, bridgeEnabled: true)
    // A load that failed at once has already discarded it.
    return parked === spare
  }

  /// The parked spare's session id for a screen opening `directory`, handed out once.
  func claim(directory: String) -> String? {
    guard let spare = parked, spare.directory == directory, spare.document.isUsable else {
      return nil
    }
    parked = nil
    claimed = spare
    DispatchQueue.main.asyncAfter(deadline: .now() + claimExpirySeconds) { [weak self, weak spare] in
      if let self, let spare, self.claimed === spare {
        self.discard(spare)
      }
    }
    return spare.sessionId
  }

  /// The claimed spare when `sessionId` names it, else a fresh document, which leaves no room for a spare.
  func document(for sessionId: String, sink: MobileWebShellDocumentSink) -> MobileWebShellDocument {
    let document: MobileWebShellDocument
    if let spare = claimed, spare.sessionId == sessionId, spare.document.isUsable {
      claimed = nil
      document = spare.document
      let webView = document.webView
      webView.removeFromSuperview()
      webView.alpha = 1
      webView.isUserInteractionEnabled = true
      webView.accessibilityElementsHidden = false
      webView.autoresizingMask = []
      spare.handOver(to: sink)
    } else {
      discardAll()
      document = MobileWebShellDocument()
      document.sink = sink
    }
    shown.add(document)
    return document
  }

  /// A spare is the first thing to give back: nothing is shown by it.
  func didReceiveMemoryWarning() {
    memoryWarningUptime = ProcessInfo.processInfo.systemUptime
    discardAll()
  }

  /// The app leaving the foreground, files going away, Home without a claim, or memory pressure.
  func discardAll() {
    for spare in [parked, claimed].compactMap({ $0 }) {
      spare.document.destroy()
    }
    parked = nil
    claimed = nil
  }

  fileprivate func discard(_ spare: MobileWebShellSpare) {
    if parked === spare {
      parked = nil
    } else if claimed === spare {
      claimed = nil
    } else {
      return
    }
    spare.document.destroy()
  }

  private func recentlyWarnedAboutMemory() -> Bool {
    guard let memoryWarningUptime else { return false }
    return ProcessInfo.processInfo.systemUptime - memoryWarningUptime < memoryWarningBackoffSeconds
  }

  private func keyWindow() -> UIWindow? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)
  }
}
