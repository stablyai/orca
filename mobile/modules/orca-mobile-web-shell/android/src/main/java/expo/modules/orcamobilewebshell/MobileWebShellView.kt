package expo.modules.orcamobilewebshell

import android.annotation.SuppressLint
import android.content.Context
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * React Native's handle on one document. The document is taken on the first prop commit, not in the
 * constructor, because that is when the session id says whether a spare was booted for it.
 */
@SuppressLint("ViewConstructor")
internal class OrcaMobileWebShellView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  private val onLoadState by EventDispatcher<Map<String, Any>>()
  private val onBridgeMessage by EventDispatcher<Map<String, Any>>()
  private val onExternalNavigation by EventDispatcher<Map<String, Any>>()

  private var generationDirectory = ""
  private var sessionId = ""
  private var bridgeEnabled = false
  private var document: MobileWebShellDocument? = null

  private val sink = object : MobileWebShellDocumentSink {
    override fun documentLoadState(payload: Map<String, Any>) = onLoadState(payload)
    override fun documentBridgeMessage(json: String) = onBridgeMessage(mapOf("json" to json))
    override fun documentExternalNavigation(url: String) = onExternalNavigation(mapOf("url" to url))
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

  /** A spare claimed under this session id, with what it said while parked, or a fresh document. */
  private fun hostDocument(): MobileWebShellDocument {
    val adopted = MobileWebShellSparePool.adopt(sessionId)
    val document = adopted?.document ?: MobileWebShellDocument(context)
    document.webView?.let { webView ->
      (webView.parent as? ViewGroup)?.removeView(webView)
      addView(webView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }
    adopted?.unpark()
    // Chromium reports an unpaused, never-attached WebView as visible, and a screen pushed under another never attaches.
    if (!isAttachedToWindow) document.pause()
    document.sink = sink
    adopted?.replayInto(sink)
    MobileWebShellSparePool.documentShown()
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
    val current = document ?: return
    document = null
    current.destroyWebView()
    MobileWebShellSparePool.documentReleased()
  }
}
