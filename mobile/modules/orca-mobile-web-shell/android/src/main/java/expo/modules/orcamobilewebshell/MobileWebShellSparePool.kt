package expo.modules.orcamobilewebshell

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import java.util.Collections
import java.util.WeakHashMap

/** More than 3 GiB can only come from a phone with 4 GB or more; those report about 3.5 to 3.9 GiB. */
private const val MINIMUM_TOTAL_MEMORY_BYTES = 3L shl 30

/** A claim is adopted on the claiming screen's first commit; this only bounds a screen that never mounts. */
private const val CLAIM_EXPIRY_MS = 10_000L

/** Holds a parked WebView under the app's content: invisible, untouchable and out of accessibility. */
private class MobileWebShellParking(context: Context) : FrameLayout(context) {
  init {
    alpha = 0f
    isFocusable = false
    descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
  }

  override fun dispatchTouchEvent(event: MotionEvent): Boolean = false
}

/**
 * A booted document waiting for a screen. It keeps what the page reported, and the page's ready, for
 * the view that adopts it: a parked page stops asking for init, so its ready is answered from here.
 */
internal class MobileWebShellSpare(
  activity: Activity,
  val directory: String,
  val sessionId: String
) : MobileWebShellDocumentSink {
  val document = MobileWebShellDocument(activity)
  val parking: ViewGroup = MobileWebShellParking(activity)
  private val loadStates = mutableListOf<Map<String, Any>>()
  private var ready: String? = null

  init {
    document.sink = this
  }

  override fun documentLoadState(payload: Map<String, Any>) {
    loadStates += payload
    if (payload["state"] == "failed") MobileWebShellSparePool.discard(this)
  }

  /** Before init a page only sends ready, from its first document or one it reloaded. */
  override fun documentBridgeMessage(json: String) {
    ready = json
    document.postHostFrame(MOBILE_WEB_SHELL_PARKED_FRAME)
  }

  // A parked page has no screen to have been tapped on.
  override fun documentExternalNavigation(url: String) = Unit

  /** The adopting view sees what a fresh document would have reported, ready last. */
  fun handOver(sink: MobileWebShellDocumentSink) {
    document.sink = sink
    loadStates.forEach(sink::documentLoadState)
    ready?.let(sink::documentBridgeMessage)
  }

  fun destroy() {
    document.destroyWebView()
    (parking.parent as? ViewGroup)?.removeView(parking)
  }
}

/**
 * At most one document booted ahead of its screen, only while no page document is shown. Main thread only.
 * Parked attached under the content, not detached: a detached WebView took 0.3–1.9 s to paint after 30 s, vs 0.2 s.
 */
internal object MobileWebShellSparePool {
  private val main = Handler(Looper.getMainLooper())
  private var parked: MobileWebShellSpare? = null
  private var claimed: MobileWebShellSpare? = null
  private val shown: MutableSet<MobileWebShellDocument> =
    Collections.newSetFromMap(WeakHashMap())

  /** Whether a spare for [directory] is parked after the call; never on a small phone or beside a page. */
  fun prepare(activity: Activity, directory: String, sessionId: String): Boolean {
    if (!inForeground() || cannotAffordSpare(activity) || shown.any { it.webView != null }) return false
    val current = parked
    if (current != null && current.directory == directory && current.document.isUsable) return true
    val decor = activity.window?.decorView as? ViewGroup ?: return false
    // A claim no view adopted was abandoned; it must not outlive the spare that replaces it.
    discardAll()
    val spare = MobileWebShellSpare(activity, directory, sessionId)
    val webView = spare.document.webView ?: return false
    spare.parking.addView(webView, FrameLayout.LayoutParams(MATCH, MATCH))
    decor.addView(spare.parking, 0, FrameLayout.LayoutParams(MATCH, MATCH))
    parked = spare
    spare.document.apply(directory, sessionId, bridgeEnabled = true)
    // A load that failed at once has already discarded it.
    return parked === spare
  }

  /** The parked spare's session id for a screen opening [directory], handed out once. */
  fun claim(directory: String): String? {
    val spare = parked ?: return null
    if (spare.directory != directory || !spare.document.isUsable) return null
    parked = null
    claimed = spare
    main.postDelayed({ if (claimed === spare) discard(spare) }, CLAIM_EXPIRY_MS)
    return spare.sessionId
  }

  /** The claimed spare when [sessionId] names it, else a fresh document, which leaves no room for a spare. */
  fun document(
    context: Context,
    sessionId: String,
    sink: MobileWebShellDocumentSink
  ): MobileWebShellDocument {
    val spare = claimed
    val document = if (spare != null && spare.sessionId == sessionId && spare.document.isUsable) {
      claimed = null
      spare.document.webView?.let { spare.parking.removeView(it) }
      (spare.parking.parent as? ViewGroup)?.removeView(spare.parking)
      spare.handOver(sink)
      spare.document
    } else {
      discardAll()
      MobileWebShellDocument(context).also { it.sink = sink }
    }
    shown += document
    return document
  }

  /** Memory pressure, the app leaving the foreground, files going away, or Home without a claim. */
  fun discardAll() {
    listOfNotNull(parked, claimed).forEach(MobileWebShellSpare::destroy)
    parked = null
    claimed = null
  }

  fun discard(spare: MobileWebShellSpare) {
    when {
      parked === spare -> parked = null
      claimed === spare -> claimed = null
      else -> return
    }
    spare.destroy()
  }

  /** React Native keeps its activity after it stops, so ask the process's own importance. */
  private fun inForeground(): Boolean {
    val state = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(state)
    return state.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  private fun cannotAffordSpare(activity: Activity): Boolean {
    val manager = activity.getSystemService(ActivityManager::class.java) ?: return true
    val memory = ActivityManager.MemoryInfo().also(manager::getMemoryInfo)
    // Android 14 stopped sending RUNNING_LOW trims to foreground apps, so check pressure before booting.
    return manager.isLowRamDevice || memory.totalMem <= MINIMUM_TOTAL_MEMORY_BYTES || memory.lowMemory
  }
}

private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
