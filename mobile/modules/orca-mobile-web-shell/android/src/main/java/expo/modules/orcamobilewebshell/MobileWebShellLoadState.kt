package expo.modules.orcamobilewebshell

/** The wire names the TypeScript parser accepts; a swap here is a silent change of meaning. */
internal enum class MobileWebShellFailureReason(val wireName: String) {
  GENERATION_UNREADABLE("generation-unreadable"),
  ISOLATION_UNAVAILABLE("isolation-unavailable"),
  DOCUMENT_LOAD_FAILED("document-load-failed"),
  RENDER_PROCESS_GONE("render-process-gone")
}

internal data class MobileWebShellLoadEmission(val state: String, val reason: String?) {
  fun toPayload(): Map<String, Any> = if (reason == null) {
    mapOf("state" to state)
  } else {
    mapOf("state" to state, "reason" to reason)
  }
}

/**
 * What a mount is still allowed to report. A failure is terminal: Chromium commits its own error
 * document after `onReceivedError` returns, and a rule list can fail to compile long after the
 * generation was already refused, so without this a `ready` or a second reason lands on top of a
 * failure the caller has already acted on. Consecutive duplicates are dropped as well.
 *
 * Pure, and the same rule on both platforms, so a JVM test and a `swiftc` check can hold it. The
 * two fields a caller reads directly are volatile: Android decides a document failure from
 * `shouldInterceptRequest`, which Chromium does not run on the UI thread.
 */
internal class MobileWebShellLoadStateMachine {
  private var terminal = false
  private var last: MobileWebShellLoadEmission? = null

  /** Which load this machine is reporting on. Read before deferring work, checked on delivery. */
  @Volatile
  var epoch: Int = 0
    private set

  /**
   * Whether a document under the current prop triple has committed. The document a load replaces
   * stays alive between `stopLoading` and the next commit, and it is same-origin whenever only the
   * directory or the bridge prop changed, so without this it passes every origin check and speaks
   * for a load the caller has already been told is `loading`.
   */
  @Volatile
  var hasCommittedDocument = false
    private set

  /** A new prop pair. Nothing else reopens a terminal state: a retry is a remount. */
  fun reset() {
    terminal = false
    last = null
    epoch += 1
    documentEnded()
  }

  fun committed() {
    if (terminal) return
    hasCommittedDocument = true
  }

  /** The committed document is gone: a new load, a failure, or a renderer that died. */
  fun documentEnded() {
    hasCommittedDocument = false
  }

  fun started(): MobileWebShellLoadEmission? = emit(MobileWebShellLoadEmission("loading", null))

  fun finished(): MobileWebShellLoadEmission? = emit(MobileWebShellLoadEmission("ready", null))

  fun failed(reason: MobileWebShellFailureReason): MobileWebShellLoadEmission? {
    val emission = emit(MobileWebShellLoadEmission("failed", reason.wireName))
    terminal = true
    documentEnded()
    return emission
  }

  /**
   * A failure decided during one load and reported after the next one started belongs to neither:
   * Android has to defer its report past Chromium's error document, and a prop update can land in
   * between, which would fail the generation that just replaced the one that actually failed.
   */
  fun failedDuring(epoch: Int, reason: MobileWebShellFailureReason): MobileWebShellLoadEmission? =
    if (epoch != this.epoch) null else failed(reason)

  private fun emit(emission: MobileWebShellLoadEmission): MobileWebShellLoadEmission? {
    if (terminal || emission == last) return null
    last = emission
    return emission
  }
}
