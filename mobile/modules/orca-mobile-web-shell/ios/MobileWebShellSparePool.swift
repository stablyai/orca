import UIKit
import WebKit

/// How long a taken spare waits for the view that asked for it before it is destroyed.
private let claimExpirySeconds: TimeInterval = 10

/// Under this, a second WebContent process costs more than the entry it speeds up.
private let minimumPhysicalMemory: UInt64 = 3 << 30

/// Parked documents plus shown ones above this never get a spare beside them.
private let maximumLiveDocuments = 2

/// A booted document waiting for a screen. It records what the page says until a view adopts it,
/// then replays it in order: the load states, so the session sees a fresh view's loading-then-ready,
/// and the page's last `ready`, which it may otherwise not repeat for two seconds.
final class MobileWebShellSpare: MobileWebShellSparePage, MobileWebShellDocumentSink {
  let document: MobileWebShellDocument
  private var loadStates: [[String: Any]] = []
  private var lastFrame: String?

  init(document: MobileWebShellDocument) {
    self.document = document
    document.sink = self
  }

  var isUsable: Bool { document.isUsable }

  func destroy() {
    document.destroy()
  }

  func documentLoadState(_ payload: [String: Any]) {
    loadStates.append(payload)
    if payload["state"] as? String == "failed" {
      MobileWebShellSparePool.shared.discardParked(self)
    }
  }

  func documentBridgeMessage(_ json: String) {
    if lastFrame == nil {
      document.postParked()
    }
    lastFrame = json
  }

  /// A parked page has no screen to have been tapped on.
  func documentExternalNavigation(_ url: String) {}

  func replay(into sink: MobileWebShellDocumentSink) {
    loadStates.forEach(sink.documentLoadState)
    if let lastFrame {
      sink.documentBridgeMessage(lastFrame)
    }
  }
}

/// One document booted ahead of the screen that will show it, app-wide. Main thread only.
///
/// Parked in the key window beneath everything, at alpha 0 with touches and accessibility off, not
/// off-window: WebKit treats an off-window view as hidden and suspends it, and a spare parked off-window
/// for 30 s took 0.5 to 1.3 s to paint after attaching (100 ms attached).
final class MobileWebShellSparePool {
  static let shared = MobileWebShellSparePool()

  private let slots = MobileWebShellSpareSlots<MobileWebShellSpare>()
  private var shownDocuments = 0

  /// False when no spare was booted: a small phone, the app not active, enough documents live, one
  /// of this build already parked, or another one parked and `replace` false.
  func prepare(
    buildId: String,
    hostKey: String,
    directory: String,
    sessionId: String,
    replace: Bool
  ) -> Bool {
    guard
      ProcessInfo.processInfo.physicalMemory >= minimumPhysicalMemory,
      UIApplication.shared.applicationState == .active,
      shownDocuments < maximumLiveDocuments,
      slots.wants(buildId: buildId, replace: replace),
      let window = keyWindow()
    else { return false }
    let spare = MobileWebShellSpare(document: MobileWebShellDocument())
    let webView = spare.document.webView
    webView.alpha = 0
    webView.isUserInteractionEnabled = false
    webView.accessibilityElementsHidden = true
    webView.translatesAutoresizingMaskIntoConstraints = true
    webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    webView.frame = window.bounds
    window.insertSubview(webView, at: 0)
    slots.park(
      MobileWebShellSpareEntry(buildId: buildId, hostKey: hostKey, sessionId: sessionId, page: spare)
    )
    spare.document.apply(generationDirectory: directory, sessionId: sessionId, bridgeEnabled: true)
    return true
  }

  /// The spare's session id for a screen about to open `directory`, which must hold the same build.
  /// The spare then reads `directory`, so the host it booted from can go away under it.
  func take(buildId: String, hostKey: String, directory: String) -> String? {
    guard
      slots.holds(buildId: buildId),
      let generation = try? MobileWebShellGeneration.load(directoryPath: directory),
      let entry = slots.take(
        buildId: buildId,
        directoryBuildId: generation.buildId,
        hostKey: hostKey
      )
    else { return nil }
    entry.page.document.repoint(to: generation, directory: directory)
    let sessionId = entry.sessionId
    DispatchQueue.main.asyncAfter(deadline: .now() + claimExpirySeconds) { [weak self] in
      self?.slots.expire(sessionId: sessionId)
    }
    return sessionId
  }

  func adopt(sessionId: String) -> MobileWebShellSpare? {
    slots.adopt(sessionId: sessionId)?.page
  }

  /// Nil for every host: memory pressure, the app leaving the foreground, or the module going away.
  func discard(hostKey: String?) {
    slots.discard(hostKey: hostKey)
  }

  func discardParked(_ spare: MobileWebShellSpare) {
    slots.discardParked(ifSame: spare)
  }

  /// A screen that could not use the spare leaves no room for it beside the documents now shown.
  func documentShown() {
    shownDocuments += 1
    if shownDocuments >= maximumLiveDocuments {
      slots.discardParked()
    }
  }

  func documentReleased() {
    shownDocuments -= 1
  }

  private func keyWindow() -> UIWindow? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)
  }
}
