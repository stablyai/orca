import Foundation

/// The prop triple a load was started for, and the only thing that decides whether the next prop
/// commit re-enters.
///
/// Framework-free on purpose: `tests/MobileWebShellChecks.swift` compiles this file with `swiftc`
/// and checks it without a device or a simulator.
///
/// Recording the props rather than the outcome is what makes a failure converge. A guard that reads
/// whether the bridge actually installed never agrees with a prop that is true but could not be
/// honoured — a malformed session id, an unreadable generation, a WebView too old for the listener
/// — so every later commit re-enters, resets the machine, and re-emits loading then failed forever.
struct MobileWebShellAppliedProps {
  var generationDirectory: String
  var sessionId: String
  var bridgeEnabled: Bool

  /// Field by field rather than `Equatable`: a synthesized `==` would grow with any field added to
  /// the record, which is how a prop nobody meant to be a reload becomes one.
  func matches(_ other: MobileWebShellAppliedProps) -> Bool {
    generationDirectory == other.generationDirectory
      && sessionId == other.sessionId
      && bridgeEnabled == other.bridgeEnabled
  }
}
