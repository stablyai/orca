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

/// Failure is terminal and duplicate reports are dropped: late error-document/rule-list callbacks must never restore ready.
final class MobileWebShellLoadStateMachine {
  private var isTerminal = false
  private var last: MobileWebShellLoadEmission?

  /// Accept messages only after the current props’ document commits; the replaced same-origin document can still speak before then.
  private(set) var hasCommittedDocument = false

  /// Keep the own-load flag in the state machine so every document-ending path clears it.
  private(set) var isShellLoad = false

  /// The view is about to load the document itself. The only thing that raises the flag.
  func shellLoadStarted() {
    isShellLoad = true
  }

  /// Spend the own-load flag at the policy decision: WebKit may decide a second action before the first commits.
  func shellLoadConsumed() {
    isShellLoad = false
  }

  /// A new prop pair. Nothing else reopens a terminal state: a retry is a remount.
  func reset() {
    isTerminal = false
    last = nil
    documentEnded()
  }

  func committed() {
    isShellLoad = false
    guard !isTerminal else { return }
    hasCommittedDocument = true
  }

  /// The committed document is gone: a new load, a failure, or a renderer that died.
  func documentEnded() {
    hasCommittedDocument = false
    isShellLoad = false
  }

  func started() -> MobileWebShellLoadEmission? {
    emit(MobileWebShellLoadEmission(state: "loading", reason: nil))
  }

  /// Require a commit, not URL equality: history.replaceState changes / to /h/<hostId> before finish, otherwise ready never arrives.
  func finished() -> MobileWebShellLoadEmission? {
    guard hasCommittedDocument else { return nil }
    return emit(MobileWebShellLoadEmission(state: "ready", reason: nil))
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

/// Ignore stopLoading/policy cancellations so healthy generations are not redownloaded. Legacy WebKitErrorDomain frame-load codes lack iOS SDK symbols.
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
