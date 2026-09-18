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

  /// A new prop pair. Nothing else reopens a terminal state: a retry is a remount.
  func reset() {
    isTerminal = false
    last = nil
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
    return emission
  }

  private func emit(_ emission: MobileWebShellLoadEmission) -> MobileWebShellLoadEmission? {
    guard !isTerminal, emission != last else { return nil }
    last = emission
    return emission
  }
}
