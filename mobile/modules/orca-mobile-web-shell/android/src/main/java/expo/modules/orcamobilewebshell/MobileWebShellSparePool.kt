package expo.modules.orcamobilewebshell

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebView

/** How long a taken spare waits for the view that asked for it before it is destroyed. */
private const val CLAIM_EXPIRY_MS = 10_000L

/**
 * Holds what a parked page says until a view adopts it, then hands it over in order: the load
 * states, so the session sees the same loading-then-ready it sees from a fresh view, and the page's
 * last `ready`, which it may otherwise not repeat for two seconds.
 */
internal class MobileWebShellParkedSink : MobileWebShellPageSink {
  private val loadStates = mutableListOf<Map<String, Any>>()
  var lastFrame: String? = null
    private set

  override fun pageLoadState(payload: Map<String, Any>) {
    loadStates += payload
  }

  override fun pageBridgeMessage(json: String) {
    lastFrame = json
  }

  // A parked page has no screen to have been tapped on.
  override fun pageExternalNavigation(url: String) = Unit

  fun replayInto(sink: MobileWebShellPageSink) {
    loadStates.forEach(sink::pageLoadState)
    lastFrame?.let(sink::pageBridgeMessage)
  }
}

internal class MobileWebShellSpare(
  val page: MobileWebShellPage,
  val parked: MobileWebShellParkedSink
) : MobileWebShellSparePage {
  override val isUsable: Boolean get() = page.isUsable

  override fun destroy() = page.destroyWebView()
}

/**
 * One page booted ahead of the screen that will show it, app-wide. Parked detached and laid out at
 * the window's size: Chromium boots it as visible, and attaching it later costs one frame. Main
 * thread only.
 */
internal object MobileWebShellSparePool {
  private val slots = MobileWebShellSpareSlots<MobileWebShellSpare>()
  private val main = Handler(Looper.getMainLooper())

  fun prepare(activity: Activity, hostKey: String, directory: String, sessionId: String) {
    if (!slots.wants(hostKey, directory)) return
    slots.park(hostKey, directory, sessionId) {
      val page = MobileWebShellPage(activity)
      val sink = MobileWebShellParkedSink()
      page.sink = sink
      page.webView?.let { layOutDetached(it, activity) }
      page.apply(directory, sessionId, bridgeEnabled = true)
      MobileWebShellSpare(page, sink)
    }
  }

  /** The spare's session id when it was booted from `directory` and is still alive. */
  fun take(hostKey: String, directory: String): String? {
    val spare = slots.take(hostKey, directory) ?: return null
    main.postDelayed({ slots.expire(spare.sessionId) }, CLAIM_EXPIRY_MS)
    return spare.sessionId
  }

  fun adopt(sessionId: String): MobileWebShellSpare? = slots.adopt(sessionId)?.page

  fun reserve(sessionId: String): Boolean = slots.reserve(sessionId)

  fun discard(hostKey: String?) = slots.discard(hostKey)

  fun discardAll() = slots.discardAll()

  /** Never attached, so it is measured by hand: the page boots at the size it will be shown at. */
  private fun layOutDetached(view: WebView, activity: Activity) {
    val decor = activity.window?.decorView
    val metrics = activity.resources.displayMetrics
    val width = decor?.width?.takeIf { it > 0 } ?: metrics.widthPixels
    val height = decor?.height?.takeIf { it > 0 } ?: metrics.heightPixels
    view.measure(
      View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY)
    )
    view.layout(0, 0, width, height)
  }
}
