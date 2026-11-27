package expo.modules.orcamobilewebshell

import android.annotation.SuppressLint
import android.content.Context
import android.content.MutableContextWrapper
import android.view.View
import android.view.View.MeasureSpec
import android.view.ViewGroup
import android.webkit.WebView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/** React Native's handle on one document: it lays the WebView out and forwards what it reports. */
@SuppressLint("ViewConstructor")
internal class OrcaMobileWebShellView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext), MobileWebShellDocumentSink {
  companion object {
    private val activeViews =
      java.util.Collections.newSetFromMap(java.util.WeakHashMap<OrcaMobileWebShellView, Boolean>())

    private val retainedPool = MobileWebShellSlotPool<MobileWebShellDocument> { slot ->
      slot.sink = null
      detachWebViewFromParent(slot.webView)
      slot.destroyWebView()
    }

    fun clearRetainedSlot() {
      retainedPool.clear()
    }

    private fun harvestRetiringView(
      requester: OrcaMobileWebShellView,
      target: MobileWebShellAppliedProps
    ) {
      val retiring = activeViews.firstOrNull { view ->
        view !== requester && view.document?.webView != null && view.applied?.matches(target) == true
      } ?: return
      retiring.destroyWebView()
    }

    private fun detachWebViewFromParent(view: View?) {
      val child = view ?: return
      val parent = child.parent as? ViewGroup ?: return
      // Drop a disappearing-child entry or the next addView crashes: the child already has a parent.
      parent.endViewTransition(child)
      parent.removeView(child)
      parent.endViewTransition(child)
    }
  }

  private val onLoadState by EventDispatcher<Map<String, Any>>()
  private val onBridgeMessage by EventDispatcher<Map<String, Any>>()
  private val onExternalNavigation by EventDispatcher<Map<String, Any>>()

  private var generationDirectory = ""
  private var sessionId = ""
  private var bridgeEnabled = false
  // Host page only. A child route must not take or replace the parked WebView.
  private var retainsSlot = true
  /** Taken on the first prop commit, not in init: the session id says whether a spare was booted for it. */
  private var document: MobileWebShellDocument? = null
  private var applied: MobileWebShellAppliedProps? = null
  // The document does not expose commit; only a host that reached ready is worth parking.
  private var sawReady = false

  fun setGenerationDirectory(value: String) {
    generationDirectory = value
  }

  fun setSessionId(value: String) {
    sessionId = value
  }

  fun setBridgeEnabled(value: Boolean) {
    bridgeEnabled = value
  }

  fun setRetainsSlot(value: Boolean) {
    retainsSlot = value
  }

  /**
   * Props arrive in no defined order, so neither setter starts anything; this does, once both are
   * in. A repeat of the same triple is not a retry: a retry is a remount under a new React key.
   */
  fun propsDidUpdate() {
    val next = MobileWebShellAppliedProps(generationDirectory, sessionId, bridgeEnabled)
    if (document == null) {
      harvestRetiringView(this, next)
      if (retainsSlot) {
        val retained = retainedPool.takeMatchingOrEvict(next)
        if (retained != null && attachRetainedSlot(retained, next)) {
          return
        }
      }
      document = hostDocument()
    }
    applied = next
    document?.apply(generationDirectory, sessionId, bridgeEnabled)
  }

  private fun hostDocument(): MobileWebShellDocument {
    // Wrapper so a parked host can drop the destroyed view's context and adopt the next mount's.
    val hosted = MobileWebShellSparePool.document(MutableContextWrapper(context), sessionId, this)
    val webView = hosted.webView
    if (webView != null) {
      addView(webView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }
    // Why: Chromium reports an unpaused, never-attached WebView as visible, and a screen pushed under another never attaches.
    if (!isAttachedToWindow) hosted.pause()
    activeViews.add(this)
    return hosted
  }

  override fun startViewTransition(view: View) {
    // react-native-screens walks every ViewGroup in a popping screen and calls startViewTransition
    // on its children. Starting a disappearing transition on the internal WebView keeps its parent
    // reference alive in mDisappearingChildren after removeView(), which crashes re-attachment on
    // the next mount with IllegalStateException("The specified child already has a parent").
    if (view === document?.webView || view is WebView) {
      return
    }
    super.startViewTransition(view)
  }

  private fun attachRetainedSlot(
    slot: MobileWebShellDocument,
    next: MobileWebShellAppliedProps
  ): Boolean {
    val view = slot.webView
    if (view == null || !slot.isUsable) {
      slot.sink = null
      slot.destroyWebView()
      return false
    }
    val attached = runCatching {
      detachWebViewFromParent(view)
      (view.context as? MutableContextWrapper)?.baseContext = context
      view.visibility = View.VISIBLE
      addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      if (width > 0 && height > 0) {
        view.measure(
          MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
          MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY)
        )
        view.layout(0, 0, width, height)
      }
      if (isAttachedToWindow) slot.resume() else slot.pause()
    }.isSuccess
    if (!attached) {
      slot.sink = null
      slot.destroyWebView()
      return false
    }
    slot.sink = this
    document = slot
    applied = next
    sawReady = true
    activeViews.add(this)
    onLoadState(mapOf("state" to "loading"))
    onLoadState(mapOf("state" to "ready"))
    return true
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
    activeViews.remove(this)
    val current = document ?: return
    val currentApplied = applied
    val webView = current.webView
    if (retainsSlot && sawReady && current.isUsable && currentApplied != null && webView != null) {
      current.sink = null
      current.pause()
      (webView.context as? MutableContextWrapper)?.baseContext = context.applicationContext
      detachWebViewFromParent(webView)
      document = null
      applied = null
      sawReady = false
      retainedPool.retain(currentApplied, current)
      return
    }
    current.sink = null
    current.destroyWebView()
    document = null
    applied = null
    sawReady = false
  }

  override fun documentLoadState(payload: Map<String, Any>) {
    when (payload["state"]) {
      "loading" -> sawReady = false
      "ready" -> sawReady = true
      "failed" -> sawReady = false
    }
    onLoadState(payload)
  }

  override fun documentBridgeMessage(json: String) = onBridgeMessage(mapOf("json" to json))

  override fun documentExternalNavigation(url: String) = onExternalNavigation(mapOf("url" to url))
}
