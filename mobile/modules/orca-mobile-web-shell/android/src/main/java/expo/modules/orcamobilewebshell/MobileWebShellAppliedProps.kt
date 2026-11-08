package expo.modules.orcamobilewebshell

/** Record requested props, not install success, so an unfulfillable bridge prop cannot trigger endless loading/failure loops. */
internal class MobileWebShellAppliedProps(
  val generationDirectory: String,
  val sessionId: String,
  val bridgeEnabled: Boolean
) {
  /** Compare fields explicitly so adding a record field cannot silently add a reload trigger. */
  fun matches(other: MobileWebShellAppliedProps): Boolean =
    generationDirectory == other.generationDirectory &&
      sessionId == other.sessionId &&
      bridgeEnabled == other.bridgeEnabled
}
