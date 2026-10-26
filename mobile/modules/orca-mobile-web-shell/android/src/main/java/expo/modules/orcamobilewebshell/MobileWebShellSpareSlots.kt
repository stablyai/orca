package expo.modules.orcamobilewebshell

/** What the slots need from a booted page: whether it can still be shown, and how it goes away. */
internal interface MobileWebShellSparePage {
  val isUsable: Boolean
  fun destroy()
}

internal class MobileWebShellSpareEntry<P : MobileWebShellSparePage>(
  val hostKey: String,
  val directory: String,
  val sessionId: String,
  val page: P
)

/**
 * Who holds the spare: at most one parked app-wide, any number claimed by views about to adopt
 * them. The same rules as the Swift copy, and pure, so a JVM test can hold them.
 *
 * A session id is loaded by one WebView, ever. `park` refuses an id it has seen, `take` moves the
 * spare out of the parked slot before the caller learns its id, and [reserve] refuses an issued id
 * whose page is gone, so the view that names it does not build a second page under it.
 */
internal class MobileWebShellSpareSlots<P : MobileWebShellSparePage> {
  private var parked: MobileWebShellSpareEntry<P>? = null
  private val claimed = HashMap<String, MobileWebShellSpareEntry<P>>()
  private val issued = HashSet<String>()

  /** False when a live spare for this host and directory is already parked. */
  fun wants(hostKey: String, directory: String): Boolean {
    val current = parked ?: return true
    return current.hostKey != hostKey || current.directory != directory || !current.page.isUsable
  }

  /**
   * Replaces whatever is parked with a page booted for `sessionId`, built by `boot` only once the id
   * is known to be fresh. False, and nothing built, for an id seen before.
   */
  fun park(hostKey: String, directory: String, sessionId: String, boot: () -> P): Boolean {
    discardParked()
    if (!issued.add(sessionId)) return false
    parked = MobileWebShellSpareEntry(hostKey, directory, sessionId, boot())
    return true
  }

  /** The parked spare when it was booted for this host from `directory` and is still alive. */
  fun take(hostKey: String, directory: String): MobileWebShellSpareEntry<P>? {
    val spare = parked ?: return null
    if (spare.hostKey != hostKey || spare.directory != directory || !spare.page.isUsable) {
      return null
    }
    parked = null
    claimed[spare.sessionId] = spare
    return spare
  }

  fun adopt(sessionId: String): MobileWebShellSpareEntry<P>? = claimed.remove(sessionId)

  /** A claimed spare no view adopted in time. */
  fun expire(sessionId: String) {
    claimed.remove(sessionId)?.page?.destroy()
  }

  /** Marks an id a view is about to load. False when it was issued before. */
  fun reserve(sessionId: String): Boolean = issued.add(sessionId)

  /** Null for every host. A view still to adopt a discarded claim finds its id dead and remounts. */
  fun discard(hostKey: String?) {
    if (hostKey == null || parked?.hostKey == hostKey) discardParked()
    val gone = claimed.values.filter { hostKey == null || it.hostKey == hostKey }
    gone.forEach { claimed.remove(it.sessionId)?.page?.destroy() }
  }

  /** Memory pressure, the app leaving the foreground, or the module going away. */
  fun discardAll() = discard(null)

  private fun discardParked() {
    parked?.page?.destroy()
    parked = null
  }
}
