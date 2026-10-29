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

/** Failure is terminal and duplicate reports are dropped: late error-document/rule-list callbacks must never restore ready. Cross-thread readers require volatile state. */
internal class MobileWebShellLoadStateMachine {
  private var terminal = false
  private var last: MobileWebShellLoadEmission? = null

  /** Which load this machine is reporting on. Read before deferring work, checked on delivery. */
  @Volatile
  var epoch: Int = 0
    private set

  /** Accept messages only after the current props’ document commits; the replaced same-origin document can still speak before then. */
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

  /** Require a commit, not URL equality: history.replaceState changes / to /h/<hostId> before finish, otherwise ready never arrives. */
  fun finished(): MobileWebShellLoadEmission? {
    if (!hasCommittedDocument) return null
    return emit(MobileWebShellLoadEmission("ready", null))
  }

  fun failed(reason: MobileWebShellFailureReason): MobileWebShellLoadEmission? {
    val emission = emit(MobileWebShellLoadEmission("failed", reason.wireName))
    terminal = true
    documentEnded()
    return emission
  }

  /** Deferred failures belong to their original load; a prop update may replace it before delivery. */
  fun failedDuring(epoch: Int, reason: MobileWebShellFailureReason): MobileWebShellLoadEmission? =
    if (epoch != this.epoch) null else failed(reason)

  private fun emit(emission: MobileWebShellLoadEmission): MobileWebShellLoadEmission? {
    if (terminal || emission == last) return null
    last = emission
    return emission
  }
}
