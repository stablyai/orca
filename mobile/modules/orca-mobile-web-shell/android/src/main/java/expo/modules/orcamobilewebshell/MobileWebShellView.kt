package expo.modules.orcamobilewebshell

import android.annotation.SuppressLint
import android.content.Context
import android.content.MutableContextWrapper
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.ByteArrayInputStream

@SuppressLint("ViewConstructor", "SetJavaScriptEnabled")
internal class OrcaMobileWebShellView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  companion object {
    private val activeViews =
      java.util.Collections.newSetFromMap(java.util.WeakHashMap<OrcaMobileWebShellView, Boolean>())

    private fun harvestRetiringView(
      requester: OrcaMobileWebShellView,
      target: MobileWebShellAppliedProps
    ) {
      val retiring = activeViews.firstOrNull { view ->
        view !== requester && view.webView != null && view.applied?.matches(target) == true
      } ?: return
      retiring.destroyWebView()
    }

    private fun detachWebViewFromParent(view: View) {
      val parent = view.parent as? ViewGroup ?: return
      parent.endViewTransition(view)
      parent.removeView(view)
      parent.endViewTransition(view)
    }

    private fun disposeRetainedSlot(slot: RetainedMobileWebShellSlot) {
      if (slot.bridgeInstalled) {
        runCatching {
          WebViewCompat.removeWebMessageListener(slot.webView, MOBILE_WEB_SHELL_BRIDGE_OBJECT)
        }
      }
      runCatching { slot.blocker.remove() }
      slot.bridgeChannel.owner = null
      detachWebViewFromParent(slot.webView)
      slot.webView.stopLoading()
      slot.webView.destroy()
    }

    private val retainedPool = MobileWebShellSlotPool<RetainedMobileWebShellSlot> { slot ->
      disposeRetainedSlot(slot)
    }

    fun clearRetainedSlot() {
      retainedPool.clear()
    }

    private class ParkedWebViewClient(
      private val served: MobileWebShellServed
    ) : WebViewClient() {
      override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest
      ): WebResourceResponse =
        serveMobileWebShellRequest(served, request) ?: refusedMobileWebShellResponse()

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        true

      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        retainedPool.clear()
        return true
      }
    }

    private fun buildRequestParts(
      url: Uri,
      method: String = "GET",
      hasRangeHeader: Boolean = false
    ): MobileWebShellRequestParts = MobileWebShellRequestParts(
      method = method,
      hasRangeHeader = hasRangeHeader,
      scheme = url.scheme,
      host = url.host,
      port = url.port,
      userInfo = url.userInfo,
      query = url.query,
      fragment = url.fragment,
      encodedPath = url.encodedPath,
      urlLength = url.toString().length
    )

    private fun serveMobileWebShellRequest(
      current: MobileWebShellServed?,
      request: WebResourceRequest
    ): WebResourceResponse? {
      val active = current ?: return null
      val parts = buildRequestParts(
        request.url,
        method = request.method,
        hasRangeHeader = request.requestHeaders.keys.any { it.equals("Range", ignoreCase = true) }
      )
      val path = resolveMobileWebShellRequestPath(parts, active.originHost) ?: return null
      val asset = active.generation.entries[path] ?: return null
      val bytes = runCatching { asset.file.readBytes() }.getOrNull() ?: return null
      val headers = mobileWebShellResponseHeaders(path, bytes.size)
      val (mimeType, charset) = splitMobileWebShellContentType(asset.contentType)
      return WebResourceResponse(mimeType, charset, 200, "OK", headers, ByteArrayInputStream(bytes))
    }

    private fun refusedMobileWebShellResponse(): WebResourceResponse = WebResourceResponse(
      MOBILE_WEB_SHELL_REFUSAL_MIME_TYPE,
      MOBILE_WEB_SHELL_REFUSAL_CHARSET,
      MOBILE_WEB_SHELL_REFUSAL_STATUS,
      MOBILE_WEB_SHELL_REFUSAL_REASON,
      MOBILE_WEB_SHELL_REFUSAL_HEADERS,
      ByteArrayInputStream(mobileWebShellRefusalBody())
    )
  }

  private val onLoadState by EventDispatcher<Map<String, Any>>()
  private val onBridgeMessage by EventDispatcher<Map<String, Any>>()
  private val onExternalNavigation by EventDispatcher<Map<String, Any>>()

  private var generationDirectory = ""
  private var sessionId = ""
  private var bridgeEnabled = false
  // Host page only. A child route must not take or replace the parked WebView.
  private var retainsSlot = true
  private var bridgeInstalled = false
  private var bridgeChannel: MobileWebShellBridgeChannel? = null
  private val bridgeGate = MobileWebShellBridgeGate()
  // The page sends ready before native replies; volatile proxy state crosses interceptor/UI threads.
  @Volatile private var replyProxy: JavaScriptReplyProxy? = null
  private var applied: MobileWebShellAppliedProps? = null
  private val loadState = MobileWebShellLoadStateMachine()
  // Failure state crosses main-thread callbacks and Chromium’s background interceptor.
  @Volatile private var documentFailed = false
  private var renderProcessGone = false
  @Volatile private var served: MobileWebShellServed? = null
  private var blocker: ScriptHandler? = null
  private var webView: WebView? = null

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
    if (applied?.matches(next) == true) return
    if (renderProcessGone) {
      // onRenderProcessGone destroyed it. Recovery is a remount, so a new prop pair on the corpse
      // is still a failure, and one that says so beats one that goes quiet forever.
      applied = next
      loadState.reset()
      emit(loadState.failed(MobileWebShellFailureReason.RENDER_PROCESS_GONE))
      return
    }
    if (applied == null && webView == null) {
      harvestRetiringView(this, next)
      if (retainsSlot) {
        val retained = retainedPool.takeMatchingOrEvict(next)
        if (retained != null && attachRetainedSlot(retained)) {
          return
        }
      }
    }
    applied = next
    documentFailed = false
    loadState.reset()
    val view = webView ?: createWebView().also { created ->
      webView = created
      activeViews.add(this)
      addView(created, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }
    view.stopLoading()
    emit(loadState.started())

    val origin = mobileWebShellOrigin(sessionId)
    val host = mobileWebShellOriginHost(sessionId)
    if (origin == null || host == null) {
      // The private origin is the isolation primitive; a malformed session id leaves us without one.
      failPropUpdate(MobileWebShellFailureReason.ISOLATION_UNAVAILABLE)
      return
    }
    val loaded = MobileWebShellGeneration.load(generationDirectory)
    if (loaded == null) {
      failPropUpdate(MobileWebShellFailureReason.GENERATION_UNREADABLE)
      return
    }
    blocker?.remove()
    blocker = installMobileWebShellNetworkApiBlocker(view, origin)
    if (blocker == null) {
      failPropUpdate(MobileWebShellFailureReason.ISOLATION_UNAVAILABLE)
      return
    }
    if (!applyBridgeListener(view, origin)) {
      failPropUpdate(MobileWebShellFailureReason.ISOLATION_UNAVAILABLE)
      return
    }
    served = MobileWebShellServed(loaded, host)
    view.visibility = View.VISIBLE
    view.loadUrl("$origin/")
  }

  override fun startViewTransition(view: View) {
    // react-native-screens walks every ViewGroup in a popping screen and calls startViewTransition
    // on its children. Starting a disappearing transition on the internal WebView keeps its parent
    // reference alive in mDisappearingChildren after removeView(), which crashes re-attachment on
    // the next mount with IllegalStateException("The specified child already has a parent").
    if (view === webView || view is WebView) {
      return
    }
    super.startViewTransition(view)
  }

  private fun attachRetainedSlot(slot: RetainedMobileWebShellSlot): Boolean {
    val view = slot.webView
    val attached = runCatching {
      detachWebViewFromParent(view)
      (view.context as? MutableContextWrapper)?.baseContext = context
      view.webViewClient = ShellWebViewClient()
      view.visibility = View.VISIBLE
      addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      if (width > 0 && height > 0) {
        view.measure(
          MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
          MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY)
        )
        view.layout(0, 0, width, height)
      }
      view.onResume()
    }.isSuccess
    if (!attached) {
      disposeRetainedSlot(slot)
      return false
    }
    applied = slot.applied
    documentFailed = false
    served = slot.served
    blocker = slot.blocker
    bridgeChannel = slot.bridgeChannel.also { it.owner = this }
    replyProxy = slot.replyProxy
    bridgeInstalled = slot.bridgeInstalled
    webView = view
    activeViews.add(this)
    loadState.reset()
    loadState.committed()
    loadState.started()
    emit(loadState.finished())
    return true
  }

  /**
   * The generation that failed to apply replaces whatever was on screen; leaving the previous one
   * served and visible would show a page the caller has just been told is not loaded.
   */
  private fun failPropUpdate(reason: MobileWebShellFailureReason) {
    // Remove the old listener: stopLoading leaves its same-origin document alive and able to rearm replies.
    removeBridgeListener()
    served = null
    webView?.visibility = View.INVISIBLE
    emit(loadState.failed(reason))
  }

  /** addWebMessageListener injects before scripts and enforces origins; false means unsupported provider. */
  private fun applyBridgeListener(view: WebView, origin: String): Boolean {
    removeBridgeListener()
    val outcome = mobileWebShellBridgeInstall(
      bridgeEnabled,
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
    )
    if (outcome != MobileWebShellBridgeInstall.INSTALL) {
      return outcome == MobileWebShellBridgeInstall.SKIP
    }
    val channel = MobileWebShellBridgeChannel(this)
    return runCatching {
      WebViewCompat.addWebMessageListener(
        view,
        MOBILE_WEB_SHELL_BRIDGE_OBJECT,
        setOf(origin),
        channel
      )
      bridgeChannel = channel
      bridgeInstalled = true
    }.isSuccess
  }

  /** The one way the bridge goes away, so no disable path can leave a listener behind. */
  private fun removeBridgeListener() {
    val view = webView
    bridgeChannel?.owner = null
    bridgeChannel = null
    if (bridgeInstalled && view != null) {
      WebViewCompat.removeWebMessageListener(view, MOBILE_WEB_SHELL_BRIDGE_OBJECT)
    }
    bridgeInstalled = false
    replyProxy = null
  }

  /** Chromium calls this on the UI thread, which is also the only thread that may reply. */
  internal fun receiveBridgeMessage(
    message: WebMessageCompat,
    isMainFrame: Boolean,
    proxy: JavaScriptReplyProxy
  ) {
    val isStringMessage = message.type == WebMessageCompat.TYPE_STRING
    val json = if (isStringMessage) message.data else null
    if (
      acceptsMobileWebShellBridgeFrame(
        isMainFrame,
        isStringMessage,
        loadState.hasCommittedDocument
      ) && json != null &&
      bridgeGate.accepts(json.toByteArray(Charsets.UTF_8).size)
    ) {
      replyProxy = proxy
      onBridgeMessage(mapOf("json" to json))
    }
  }

  /** Throw so a host chunking bug rejects rather than leaving its request unsettled. */
  fun postBridgeMessage(json: String) {
    val proxy = replyProxy ?: throw MobileWebShellBridgeUnavailableException()
    val byteCount = json.toByteArray(Charsets.UTF_8).size
    if (!acceptsMobileWebShellBridgeByteCount(byteCount)) {
      throw MobileWebShellBridgeMessageTooLargeException(byteCount)
    }
    proxy.postMessage(json)
  }

  /** Expo calls this once React Native is done with the view, and onRenderProcessGone calls it. */
  fun destroyWebView() {
    activeViews.remove(this)
    val view = webView ?: return
    val currentApplied = applied
    val currentServed = served
    val currentBlocker = blocker
    val currentChannel = bridgeChannel
    val canRetain =
      !renderProcessGone &&
      !documentFailed &&
      loadState.hasCommittedDocument &&
      (!bridgeEnabled || (bridgeInstalled && currentChannel != null)) &&
      currentApplied != null &&
      currentServed != null &&
      currentBlocker != null
    if (retainsSlot && canRetain) {
      val channel = currentChannel ?: MobileWebShellBridgeChannel(null)
      channel.owner = null
      view.webViewClient = ParkedWebViewClient(currentServed)
      view.onPause()
      (view.context as? MutableContextWrapper)?.baseContext = context.applicationContext
      detachWebViewFromParent(view)
      webView = null
      blocker = null
      served = null
      bridgeChannel = null
      val savedProxy = replyProxy
      val savedBridgeInstalled = bridgeInstalled
      replyProxy = null
      bridgeInstalled = false
      loadState.documentEnded()
      retainedPool.retain(
        currentApplied,
        RetainedMobileWebShellSlot(
          applied = currentApplied,
          webView = view,
          served = currentServed,
          blocker = currentBlocker,
          bridgeChannel = channel,
          replyProxy = savedProxy,
          bridgeInstalled = savedBridgeInstalled
        )
      )
      return
    }
    destroyWebViewImmediate()
  }

  private fun destroyWebViewImmediate() {
    activeViews.remove(this)
    val view = webView ?: return
    removeBridgeListener()
    loadState.documentEnded()
    webView = null
    blocker?.remove()
    blocker = null
    served = null
    documentFailed = false
    view.stopLoading()
    detachWebViewFromParent(view)
    view.destroy()
  }

  // Keep explicit settings for the Chromium 83 floor, even where newer WebViews ignore deprecated options.
  // B4 requires device proofs: no network, persistent state, file/content access, cleartext or navigation escape.
  @Suppress("DEPRECATION")
  private fun createWebView(): WebView {
    val view = WebView(MutableContextWrapper(context))
    view.setBackgroundColor(Color.TRANSPARENT)
    view.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = false
      databaseEnabled = false
      allowFileAccess = false
      allowFileAccessFromFileURLs = false
      allowUniversalAccessFromFileURLs = false
      allowContentAccess = false
      javaScriptCanOpenWindowsAutomatically = false
      setSupportMultipleWindows(false)
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      cacheMode = WebSettings.LOAD_NO_CACHE
      blockNetworkLoads = true
      mediaPlaybackRequiresUserGesture = true
      setGeolocationEnabled(false)
    }
    // clearCache(true) is process-global, including terminals; use per-view LOAD_NO_CACHE and no-store.
    view.webViewClient = ShellWebViewClient()
    view.webChromeClient = object : WebChromeClient() {
      override fun onCreateWindow(
        view: WebView?,
        isDialog: Boolean,
        isUserGesture: Boolean,
        resultMsg: Message?
      ): Boolean = false
    }
    view.setDownloadListener { _, _, _, _, _ -> }
    // Replace WebView inset handling on P–R/S+; forward zeroed insets for S+ parity.
    ViewCompat.setOnApplyWindowInsetsListener(view) { target, insets ->
      ViewCompat.onApplyWindowInsets(target, insetsForShellPage(insets))
    }
    return view
  }

  private fun emit(emission: MobileWebShellLoadEmission?) {
    if (emission != null) onLoadState(emission.toPayload())
  }

  /** Post hiding past Chromium’s error-document commit; interception may also run off the main thread. */
  private fun reportDocumentFailure() {
    replyProxy = null
    // Drop replies synchronously before Chromium’s error document commits and the posted hide runs.
    loadState.documentEnded()
    // Set before posting: intervening onPageFinished must not restore ready or expose the error page.
    documentFailed = true
    val epoch = loadState.epoch
    post {
      if (!documentFailed) return@post
      val emission = loadState.failedDuring(
        epoch,
        MobileWebShellFailureReason.DOCUMENT_LOAD_FAILED
      ) ?: return@post
      webView?.visibility = View.INVISIBLE
      emit(emission)
    }
  }

  private fun isDocumentUrl(url: Uri): Boolean {
    val host = served?.originHost ?: return false
    return resolveMobileWebShellRequestPath(requestParts(url), host) == "/"
  }

  private fun requestParts(
    url: Uri,
    method: String = "GET",
    hasRangeHeader: Boolean = false
  ): MobileWebShellRequestParts = buildRequestParts(
    url = url,
    method = method,
    hasRangeHeader = hasRangeHeader
  )

  private fun serveRequest(request: WebResourceRequest): WebResourceResponse? =
    serveMobileWebShellRequest(served, request)

  private fun refusedResponse(): WebResourceResponse = refusedMobileWebShellResponse()

  private inner class ShellWebViewClient : WebViewClient() {
    /** Never null, so no request can fall through to the network. */
    override fun shouldInterceptRequest(
      view: WebView,
      request: WebResourceRequest
    ): WebResourceResponse {
      val response = serveRequest(request)
      if (response != null) return response
      if (request.isForMainFrame) reportDocumentFailure()
      return refusedResponse()
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
      // hasGesture gates only opener offers: human requests may omit it and subframes can target top without it.
      val verdict = mobileWebShellNavigationVerdict(
        url = request.url?.toString(),
        isForMainFrame = request.isForMainFrame,
        // Not reported here, unlike WKNavigationAction.sourceFrame on iOS.
        isFromSubframe = false,
        isDocumentUrl = !mobileWebShellDropsNavigation(
          requestParts(request.url),
          served?.originHost,
          request.isForMainFrame
        ),
        // loadUrl bypasses this callback by WebViewClient contract; no callback action is our own load.
        isShellLoad = false,
        hasGesture = request.hasGesture(),
        isDownload = false
      )
      if (verdict is MobileWebShellNavigationVerdict.CancelAndOffer) {
        onExternalNavigation(mapOf("url" to verdict.url))
      }
      return verdict !is MobileWebShellNavigationVerdict.Allow
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
      // Discard the replaced document’s reply proxy; the next page must send ready.
      replyProxy = null
      loadState.documentEnded()
      if (documentFailed || !isDocumentUrl(Uri.parse(url))) return
      // Arm at commit before page script runs.
      loadState.committed()
      emit(loadState.started())
    }

    // history.replaceState changes the document path before finish; commit state identifies the load.
    override fun onPageFinished(view: WebView, url: String) {
      if (documentFailed || !loadState.hasCommittedDocument) return
      view.visibility = View.VISIBLE
      // Remove history so the page cannot return to a replaced document.
      view.clearHistory()
      emit(loadState.finished())
    }

    override fun onReceivedError(
      view: WebView,
      request: WebResourceRequest,
      error: WebResourceError
    ) {
      if (request.isForMainFrame) reportDocumentFailure()
    }

    override fun onReceivedHttpError(
      view: WebView,
      request: WebResourceRequest,
      errorResponse: WebResourceResponse
    ) {
      if (request.isForMainFrame) reportDocumentFailure()
    }

    /** Return true to avoid killing the app; destroy the dead WebView and leave retry policy to the caller. */
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      renderProcessGone = true
      destroyWebViewImmediate()
      emit(loadState.failed(MobileWebShellFailureReason.RENDER_PROCESS_GONE))
      return true
    }
  }
}

internal class MobileWebShellBridgeUnavailableException :
  CodedException("The mobile web shell bridge is not installed on this view")

internal class MobileWebShellBridgeMessageTooLargeException(byteCount: Int) : CodedException(
  "A bridge message of $byteCount bytes exceeds the " +
    "$MOBILE_WEB_SHELL_BRIDGE_MAX_MESSAGE_BYTES byte cap"
)

/** The shell already pads bars/keyboard; zero (never consume) insets to prevent WebView M144+ bar and M139+ IME double-padding. */
private fun insetsForShellPage(insets: WindowInsetsCompat): WindowInsetsCompat =
  WindowInsetsCompat.Builder(insets)
    .setInsets(SHELL_OWNED_INSET_TYPES, Insets.NONE)
    .build()

private val SHELL_OWNED_INSET_TYPES =
  WindowInsetsCompat.Type.systemBars() or
    WindowInsetsCompat.Type.displayCutout() or
    WindowInsetsCompat.Type.ime()
