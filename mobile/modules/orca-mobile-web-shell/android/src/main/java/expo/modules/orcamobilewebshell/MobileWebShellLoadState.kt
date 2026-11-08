package expo.modules.orcamobilewebshell

/** The wire names the TypeScript parser accepts; a swap here is a silent change of meaning. */
internal enum class MobileWebShellFailureReason(val wireName: String) {
  GENERATION_UNREADABLE("generation-unreadable"),
  ISOLATION_UNAVAILABLE("isolation-unavailable"),
  DOCUMENT_LOAD_FAILED("document-load-failed"),
  RENDER_PROCESS_GONE("render-process-gone")
}

/** Renderer losses also say whether Orca was off screen and whether the renderer crashed or the OS reclaimed it. */
internal data class MobileWebShellLoadEmission(
  val state: String,
  val reason: String?,
  val background: Boolean? = null,
  val crashed: Boolean? = null
) {
  fun toPayload(): Map<String, Any> = buildMap {
    put("state", state)
    reason?.let { put("reason", it) }
    background?.let { put("background", it) }
    crashed?.let { put("crashed", it) }
  }
}

/** Failure is terminal and duplicate reports are dropped: late error-document/rule-list callbacks must never restore ready. Cross-thread readers require volatile state. */
internal class MobileWebShellLoadStateMachine {
  private var terminal = false
  private var last: MobileWebShellLoadEmission? = null
  private var rendererLoss: Pair<Boolean, Boolean>? = null

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

  fun failed(
    reason: MobileWebShellFailureReason,
    background: Boolean? = null,
    crashed: Boolean? = null
  ): MobileWebShellLoadEmission? {
    val emission = emit(MobileWebShellLoadEmission("failed", reason.wireName, background, crashed))
    terminal = true
    documentEnded()
    return emission
  }

  /** A renderer loss, remembered across reset(): a prop update on the dead view reports the same loss, not a crash. */
  fun rendererGone(background: Boolean, crashed: Boolean): MobileWebShellLoadEmission? {
    rendererLoss = background to crashed
    return failed(MobileWebShellFailureReason.RENDER_PROCESS_GONE, background, crashed)
  }

  fun rendererStillGone(): MobileWebShellLoadEmission? =
    failed(MobileWebShellFailureReason.RENDER_PROCESS_GONE, rendererLoss?.first, rendererLoss?.second)

  /** Deferred failures belong to their original load; a prop update may replace it before delivery. */
  fun failedDuring(epoch: Int, reason: MobileWebShellFailureReason): MobileWebShellLoadEmission? =
    if (epoch != this.epoch) null else failed(reason)

  private fun emit(emission: MobileWebShellLoadEmission): MobileWebShellLoadEmission? {
    if (terminal || emission == last) return null
    last = emission
    return emission
  }
}
