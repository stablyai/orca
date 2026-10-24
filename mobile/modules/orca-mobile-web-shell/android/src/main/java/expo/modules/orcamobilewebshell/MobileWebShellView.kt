package expo.modules.orcamobilewebshell

import android.annotation.SuppressLint
import android.content.Context
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/** React Native's handle on one page, which is built on the first prop commit. */
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
  private var page: MobileWebShellPage? = null

  private val sink = object : MobileWebShellPageSink {
    override fun pageLoadState(payload: Map<String, Any>) =
      this@OrcaMobileWebShellView.onLoadState(payload)
    override fun pageBridgeMessage(json: String) =
      this@OrcaMobileWebShellView.onBridgeMessage(mapOf("json" to json))
    override fun pageExternalNavigation(url: String) =
      this@OrcaMobileWebShellView.onExternalNavigation(mapOf("url" to url))
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

  /** Props arrive in no defined order, so neither setter starts anything; this does, once all are in. */
  fun propsDidUpdate() {
    val current = page ?: hostPage().also { page = it }
    current.apply(generationDirectory, sessionId, bridgeEnabled)
  }

  private fun hostPage(): MobileWebShellPage {
    val page = MobileWebShellPage(context)
    page.webView?.let { addView(it, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)) }
    page.sink = sink
    return page
  }

  fun postBridgeMessage(json: String) {
    val current = page ?: throw MobileWebShellBridgeUnavailableException()
    current.postBridgeMessage(json)
  }

  /** Expo calls this once React Native is done with the view. */
  fun destroyWebView() {
    page?.destroyWebView()
  }
}
