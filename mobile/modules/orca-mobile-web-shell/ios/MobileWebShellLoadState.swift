import Foundation

/// The wire names the TypeScript parser accepts; a swap here is a silent change of meaning.
enum MobileWebShellFailureReason: String {
  case generationUnreadable = "generation-unreadable"
  case isolationUnavailable = "isolation-unavailable"
  case documentLoadFailed = "document-load-failed"
  case renderProcessGone = "render-process-gone"
}

struct MobileWebShellLoadEmission: Equatable {
  let state: String
  let reason: String?
}

/// What a mount is still allowed to report. A failure is terminal: a rule list can fail to compile
/// long after the generation was already refused, and WebKit still reports a navigation outcome
/// after a response was cancelled, so without this a second reason or a `ready` lands on top of a
/// failure the caller has already acted on. Consecutive duplicates are dropped as well.
///
/// Pure, and the same rule as the Kotlin copy, so `swiftc` can check it without a device.
final class MobileWebShellLoadStateMachine {
  private var isTerminal = false
  private var last: MobileWebShellLoadEmission?

  /// Whether a document under the current prop triple has committed. The document a load replaces
  /// stays alive between `stopLoading` and the next commit, and it is same-origin whenever only the
  /// directory or the bridge prop changed, so without this it passes every origin check and speaks
  /// for a load the caller has already been told is `loading`.
  private(set) var hasCommittedDocument = false

  /// A new prop pair. Nothing else reopens a terminal state: a retry is a remount.
  func reset() {
    isTerminal = false
    last = nil
    documentEnded()
  }

  func committed() {
    guard !isTerminal else { return }
    hasCommittedDocument = true
  }

  /// The committed document is gone: a new load, a failure, or a renderer that died.
  func documentEnded() {
    hasCommittedDocument = false
  }

  func started() -> MobileWebShellLoadEmission? {
    emit(MobileWebShellLoadEmission(state: "loading", reason: nil))
  }

  func finished() -> MobileWebShellLoadEmission? {
    emit(MobileWebShellLoadEmission(state: "ready", reason: nil))
  }

  func failed(_ reason: MobileWebShellFailureReason) -> MobileWebShellLoadEmission? {
    let emission = emit(MobileWebShellLoadEmission(state: "failed", reason: reason.rawValue))
    isTerminal = true
    documentEnded()
    return emission
  }

  private func emit(_ emission: MobileWebShellLoadEmission) -> MobileWebShellLoadEmission? {
    guard !isTerminal, emission != last else { return nil }
    last = emission
    return emission
  }
}

/// A navigation WebKit reports as failed but which is not a failure of the document.
///
/// `stopLoading` on a prop update, and every navigation the policy delegate refuses, arrive at the
/// failure delegates as errors. Reporting those would fail a healthy page, swallow its `ready`, and
/// send the caller off to delete a cached generation that is fine.
///
/// The WebKit constant is written out because the iOS SDK exports no symbol for it: `WKErrorCode`
/// stops at the content-rule-list and app-bound-domain errors, and the frame-load codes live in the
/// legacy `WebKitErrorDomain`, which WKWebView still reports a policy-cancelled frame load under.
enum MobileWebShellNavigationError {
  static let webKitDomain = "WebKitErrorDomain"
  static let frameLoadInterruptedByPolicyChange = 102

  static func isIgnorable(domain: String, code: Int) -> Bool {
    if domain == NSURLErrorDomain, code == NSURLErrorCancelled {
      return true
    }
    return domain == webKitDomain && code == frameLoadInterruptedByPolicyChange
  }
}
