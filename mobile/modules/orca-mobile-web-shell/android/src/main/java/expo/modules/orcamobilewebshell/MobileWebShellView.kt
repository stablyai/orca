package expo.modules.orcamobilewebshell

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Rect
import android.os.Build
import kotlin.math.ceil
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/** React Native's handle on one document: it lays the WebView out and forwards what it reports. */
@SuppressLint("ViewConstructor")
internal class OrcaMobileWebShellView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext), MobileWebShellDocumentSink {
  private val onLoadState by EventDispatcher<Map<String, Any>>()
  private val onBridgeMessage by EventDispatcher<Map<String, Any>>()
  private val onExternalNavigation by EventDispatcher<Map<String, Any>>()

  private var generationDirectory = ""
  private var sessionId = ""
  private var bridgeEnabled = false
  /** Taken on the first prop commit, not in init: the session id says whether a spare was booted for it. */
  private var document: MobileWebShellDocument? = null
  /** Page bands (CSS px from the top) where a swipe from the screen's edge stays with the page. */
  private var backEdgeGuards: List<Pair<Double, Double>> = emptyList()

  init {
    // The bands span the view's width, so a new width needs new rects.
    addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> applyBackEdgeGuards() }
  }

  fun setBackEdgeGuards(value: List<Map<String, Double>>) {
    backEdgeGuards = value.mapNotNull { band ->
      val top = band["top"]
      val bottom = band["bottom"]
      if (top != null && bottom != null && bottom > top) top to bottom else null
    }
    applyBackEdgeGuards()
  }

  // Why: with gesture navigation the system Back swipe takes the screen's edges first; excluded rects
  // leave the session tab bar's swipe to the page. The page's CSS px are dp at its device-width viewport.
  private fun applyBackEdgeGuards() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val density = resources.displayMetrics.density
    systemGestureExclusionRects = backEdgeGuards.map { (top, bottom) ->
      // The tab sits on the left; the right edge over the count and + stays Back's.
      Rect(0, (top * density).toInt(), width / 2, ceil(bottom * density).toInt())
    }
  }

  fun setGenerationDirectory(value: String) {
    generationDirectory = value
  }

  fun setSessionId(value: String) {
    sessionId = value
  }

  fun setBridgeEnabled(value: Boolean) {
    bridgeEnabled = value
  }

  fun propsDidUpdate() {
    val current = document ?: hostDocument().also { document = it }
    current.apply(generationDirectory, sessionId, bridgeEnabled)
  }

  private fun hostDocument(): MobileWebShellDocument {
    val document = MobileWebShellSparePool.document(context, sessionId, this)
    addView(document.webView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    // Why: Chromium reports an unpaused, never-attached WebView as visible, and a screen pushed under another never attaches.
    if (!isAttachedToWindow) document.pause()
    return document
  }

  fun postBridgeMessage(json: String) {
    val current = document ?: throw MobileWebShellBridgeUnavailableException()
    current.postBridgeMessage(json)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    document?.resume()
  }

  // Stay paused whenever off-window so the page reads hidden, as a buried WKWebView does on iOS.
  override fun onDetachedFromWindow() {
    document?.pause()
    super.onDetachedFromWindow()
  }

  /** Expo calls this once React Native is done with the view. */
  fun destroyWebView() {
    document?.destroyWebView()
  }

  override fun documentLoadState(payload: Map<String, Any>) = onLoadState(payload)

  override fun documentBridgeMessage(json: String) = onBridgeMessage(mapOf("json" to json))

  override fun documentExternalNavigation(url: String) = onExternalNavigation(mapOf("url" to url))
}
