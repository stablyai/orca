import Foundation

/// Record requested props, not install success, so an unfulfillable bridge prop cannot trigger endless loading/failure loops.
struct MobileWebShellAppliedProps {
  var generationDirectory: String
  var sessionId: String
  var bridgeEnabled: Bool

  /// Compare fields explicitly so adding a record field cannot silently add a reload trigger.
  func matches(_ other: MobileWebShellAppliedProps) -> Bool {
    generationDirectory == other.generationDirectory
      && sessionId == other.sessionId
      && bridgeEnabled == other.bridgeEnabled
  }
}
