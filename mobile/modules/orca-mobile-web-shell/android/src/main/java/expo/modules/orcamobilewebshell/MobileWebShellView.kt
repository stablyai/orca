package expo.modules.orcamobilewebshell

import android.annotation.SuppressLint
import android.content.Context
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
  private val document = MobileWebShellDocument(context)

  init {
    document.sink = this
    addView(document.webView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    // Why: Chromium reports an unpaused, never-attached WebView as visible, and a screen pushed under another never attaches.
    document.pause()
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
    document.apply(generationDirectory, sessionId, bridgeEnabled)
  }

  fun postBridgeMessage(json: String) {
    document.postBridgeMessage(json)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    document.resume()
  }

  // Stay paused whenever off-window so the page reads hidden, as a buried WKWebView does on iOS.
  override fun onDetachedFromWindow() {
    document.pause()
    super.onDetachedFromWindow()
  }

  /** Expo calls this once React Native is done with the view. */
  fun destroyWebView() {
    document.destroyWebView()
  }

  override fun documentLoadState(payload: Map<String, Any>) = onLoadState(payload)

  override fun documentBridgeMessage(json: String) = onBridgeMessage(mapOf("json" to json))

  override fun documentExternalNavigation(url: String) = onExternalNavigation(mapOf("url" to url))
}
