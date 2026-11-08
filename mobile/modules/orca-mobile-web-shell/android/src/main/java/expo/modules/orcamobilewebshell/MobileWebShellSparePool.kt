package expo.modules.orcamobilewebshell

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout

/** How long a taken spare waits for the view that asked for it before it is destroyed. */
private const val CLAIM_EXPIRY_MS = 10_000L

/** Under this, a second document costs more than the entry it speeds up. */
private const val MINIMUM_TOTAL_MEMORY_BYTES = 3L shl 30

/** Shown documents at or above this never get a spare beside them. */
private const val MAXIMUM_LIVE_DOCUMENTS = 2

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
 * A booted document waiting for a screen. It records what the page says until a view adopts it, then
 * replays it in order: the load states, so the session sees a fresh view's loading-then-ready, and the
 * page's last `ready`, which it may otherwise not repeat for two seconds.
 */
internal class MobileWebShellSpare(
  val document: MobileWebShellDocument,
  private val parking: ViewGroup
) : MobileWebShellSparePage, MobileWebShellDocumentSink {
  private val loadStates = mutableListOf<Map<String, Any>>()
  private var lastFrame: String? = null

  init {
    document.sink = this
  }

  override val isUsable: Boolean get() = document.isUsable

  override fun destroy() {
    document.destroyWebView()
    unpark()
  }

  /** Takes the parking frame out of the window; the adopting view has already taken the WebView. */
  fun unpark() {
    (parking.parent as? ViewGroup)?.removeView(parking)
  }

  override fun documentLoadState(payload: Map<String, Any>) {
    loadStates += payload
    if (payload["state"] == "failed") MobileWebShellSparePool.discardParked(this)
  }

  override fun documentBridgeMessage(json: String) {
    if (lastFrame == null) document.postParked()
    lastFrame = json
  }

  // A parked page has no screen to have been tapped on.
  override fun documentExternalNavigation(url: String) = Unit

  fun replayInto(sink: MobileWebShellDocumentSink) {
    loadStates.forEach(sink::documentLoadState)
    lastFrame?.let(sink::documentBridgeMessage)
  }
}

/**
 * One document booted ahead of the screen that will show it, app-wide. Main thread only.
 *
 * Parked attached beneath the app's content rather than detached: a detached WebView parked for 30 s
 * took 0.3 to 1.9 s to paint once shown, against 0.2 s attached.
 */
internal object MobileWebShellSparePool {
  private val slots = MobileWebShellSpareSlots<MobileWebShellSpare>()
  private val main = Handler(Looper.getMainLooper())
  private var shownDocuments = 0
  private var chromiumWarmed = false

  /**
   * False when no spare was booted: enough documents live, one of this build already parked, another
   * one parked and [replace] false, or a small phone, which only loads Chromium so the first screen
   * does not pay for it.
   */
  fun prepare(
    activity: Activity,
    buildId: String,
    hostKey: String,
    directory: String,
    sessionId: String,
    replace: Boolean
  ): Boolean {
    if (!inForeground()) return false
    if (isSmallPhone(activity)) {
      warmChromium(activity)
      return false
    }
    if (shownDocuments >= MAXIMUM_LIVE_DOCUMENTS || !slots.wants(buildId, replace)) return false
    val decor = activity.window?.decorView as? ViewGroup ?: return false
    val document = MobileWebShellDocument(activity)
    val webView = document.webView ?: return false
    val parking = MobileWebShellParking(activity)
    parking.addView(webView, FrameLayout.LayoutParams(MATCH, MATCH))
    decor.addView(parking, 0, FrameLayout.LayoutParams(MATCH, MATCH))
    val spare = MobileWebShellSpare(document, parking)
    slots.park(MobileWebShellSpareEntry(buildId, hostKey, sessionId, spare))
    document.apply(directory, sessionId, bridgeEnabled = true)
    return true
  }

  /**
   * The spare's session id for a screen about to open `directory`, which must hold the same build.
   * The spare then reads `directory`, so the host it booted from can go away under it.
   */
  fun take(buildId: String, hostKey: String, directory: String): String? {
    if (!slots.holds(buildId)) return null
    val generation = MobileWebShellGeneration.load(directory) ?: return null
    val entry = slots.take(buildId, generation.buildId, hostKey) ?: return null
    entry.page.document.repoint(generation, directory)
    main.postDelayed({ slots.expire(entry.sessionId) }, CLAIM_EXPIRY_MS)
    return entry.sessionId
  }

  fun adopt(sessionId: String): MobileWebShellSpare? = slots.adopt(sessionId)?.page

  /** Null for every host: memory pressure, the app leaving the foreground, or the module going away. */
  fun discard(hostKey: String?) = slots.discard(hostKey)

  fun discardParked(spare: MobileWebShellSpare) = slots.discardParked(spare)

  /** A screen that could not use the spare leaves no room for it beside the documents now shown. */
  fun documentShown() {
    shownDocuments += 1
    if (shownDocuments >= MAXIMUM_LIVE_DOCUMENTS) slots.discardParked()
  }

  fun documentReleased() {
    shownDocuments -= 1
  }

  /** React Native keeps its activity after it stops, so ask the process's own importance. */
  private fun inForeground(): Boolean {
    val state = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(state)
    return state.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  private fun isSmallPhone(activity: Activity): Boolean {
    val manager = activity.getSystemService(ActivityManager::class.java) ?: return true
    val memory = ActivityManager.MemoryInfo().also(manager::getMemoryInfo)
    return manager.isLowRamDevice || memory.totalMem < MINIMUM_TOTAL_MEMORY_BYTES
  }

  /** The first WebView in a process loads Chromium; pay that while nothing waits on it. */
  private fun warmChromium(activity: Activity) {
    if (chromiumWarmed) return
    chromiumWarmed = true
    WebView(activity).destroy()
  }
}

private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
