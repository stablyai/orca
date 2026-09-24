package expo.modules.orcamobilewebshell

/**
 * The prop triple a load was started for, and the only thing that decides whether the next prop
 * commit re-enters. The same rule as the Swift copy.
 *
 * Recording the props rather than the outcome is what makes a failure converge. A guard that reads
 * whether the bridge actually installed never agrees with a prop that is true but could not be
 * honoured — a malformed session id, an unreadable generation, a WebView too old for the listener —
 * so every later commit re-enters, resets the machine, and re-emits loading then failed forever.
 */
internal class MobileWebShellAppliedProps(
  private val generationDirectory: String,
  val sessionId: String,
  private val bridgeEnabled: Boolean
) {
  /**
   * Field by field rather than a data class: a generated `equals` would grow with any field added
   * to the record, which is how a prop nobody meant to be a reload becomes one.
   */
  fun matches(other: MobileWebShellAppliedProps): Boolean =
    generationDirectory == other.generationDirectory &&
      sessionId == other.sessionId &&
      bridgeEnabled == other.bridgeEnabled
}
