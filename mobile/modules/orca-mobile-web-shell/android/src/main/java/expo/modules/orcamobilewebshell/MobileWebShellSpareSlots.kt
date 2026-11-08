package expo.modules.orcamobilewebshell

/** What the slots need from a booted document: whether it can still be shown, and how it goes away. */
internal interface MobileWebShellSparePage {
  val isUsable: Boolean
  fun destroy()
}

internal class MobileWebShellSpareEntry<P : MobileWebShellSparePage>(
  val buildId: String,
  /** The host whose files it reads: the one it booted from, then the one that claimed it. */
  val hostKey: String,
  val sessionId: String,
  val page: P
)

/**
 * At most one spare parked app-wide, plus claims waiting for their view. Keyed by build, not host:
 * two hosts on one desktop version serve the same bytes. Pure, like the Swift copy, so a JVM test
 * holds the rules.
 */
internal class MobileWebShellSpareSlots<P : MobileWebShellSparePage> {
  private var parked: MobileWebShellSpareEntry<P>? = null
  private val claimed = HashMap<String, MobileWebShellSpareEntry<P>>()

  /** False when a live spare of this build is already parked, or of any build unless [replace]. */
  fun wants(buildId: String, replace: Boolean = true): Boolean {
    val current = parked?.takeIf { it.page.isUsable } ?: return true
    return replace && current.buildId != buildId
  }

  /** Replaces whatever is parked. */
  fun park(entry: MobileWebShellSpareEntry<P>) {
    discardParked()
    parked = entry
  }

  /**
   * Hands the parked spare out once, and only to a screen opening the same build: `directoryBuildId`
   * is what the claiming screen's directory holds, so a stale or mislabelled directory is refused.
   */
  /** Whether a live spare of this build is parked, before a claim pays for reading the directory. */
  fun holds(buildId: String): Boolean = parked?.buildId == buildId

  fun take(buildId: String, directoryBuildId: String?, hostKey: String): MobileWebShellSpareEntry<P>? {
    val spare = parked ?: return null
    if (spare.buildId != buildId || directoryBuildId != buildId || !spare.page.isUsable) return null
    parked = null
    val claim = MobileWebShellSpareEntry(buildId, hostKey, spare.sessionId, spare.page)
    claimed[spare.sessionId] = claim
    return claim
  }

  /** Null, and the page destroyed, when it died between claim and adoption: the view boots its own. */
  fun adopt(sessionId: String): MobileWebShellSpareEntry<P>? {
    val claim = claimed.remove(sessionId) ?: return null
    if (claim.page.isUsable) return claim
    claim.page.destroy()
    return null
  }

  /** A claimed spare no view adopted in time. */
  fun expire(sessionId: String) {
    claimed.remove(sessionId)?.page?.destroy()
  }

  /** Null for every host. */
  fun discard(hostKey: String?) {
    if (hostKey == null || parked?.hostKey == hostKey) discardParked()
    val gone = claimed.values.filter { hostKey == null || it.hostKey == hostKey }
    gone.forEach { claimed.remove(it.sessionId)?.page?.destroy() }
  }

  /** The parked spare's own renderer died or its load failed. */
  fun discardParked(page: P) {
    if (parked?.page === page) discardParked()
  }

  fun discardParked() {
    parked?.page?.destroy()
    parked = null
  }
}
