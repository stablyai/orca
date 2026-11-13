package expo.modules.orcamobilewebshell

import android.annotation.SuppressLint
import android.content.Context
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
import expo.modules.kotlin.exception.CodedException
import java.io.ByteArrayInputStream

/** Publish host and manifest map atomically/volatily: main-thread writes race Chromium’s interceptor. */
private class MobileWebShellServed(
  val generation: MobileWebShellGeneration,
  val originHost: String
)

/** Where a document's reports go: the view showing it, or the spare pool while it is parked. */
internal interface MobileWebShellDocumentSink {
  fun documentLoadState(payload: Map<String, Any>)
  fun documentBridgeMessage(json: String)
  fun documentExternalNavigation(url: String)
}

/** One WebView and every fence on it, apart from React. The view hosts it and lays it out. */
@SuppressLint("SetJavaScriptEnabled")
internal class MobileWebShellDocument(private val context: Context) {
  var sink: MobileWebShellDocumentSink? = null
  private var bridgeInstalled = false
  private val bridgeGate = MobileWebShellBridgeGate()
  // The page sends ready before native replies; volatile proxy state crosses interceptor/UI threads.
  @Volatile private var replyProxy: JavaScriptReplyProxy? = null
  private var applied: MobileWebShellAppliedProps? = null
  private val loadState = MobileWebShellLoadStateMachine()
  // Failure state crosses main-thread callbacks and Chromium’s background interceptor.
  @Volatile private var documentFailed = false
  @Volatile private var served: MobileWebShellServed? = null
  private val visualDocuments = MobileWebShellVisualDocuments()
  private var blocker: ScriptHandler? = null
  // Read by the interceptor thread when it reports a failed main-frame load.
  @Volatile var webView: WebView? = createWebView()
    private set

  /** Still showable: not torn down, and no terminal load failure or renderer loss. */
  val isUsable: Boolean get() = webView != null && !loadState.isTerminal

  /** Apply unordered props together; identical triples do not retry. Recovery requires a remount. */
  fun apply(generationDirectory: String, sessionId: String, bridgeEnabled: Boolean) {
    val next = MobileWebShellAppliedProps(generationDirectory, sessionId, bridgeEnabled)
    if (applied?.matches(next) == true) return
    applied = next
    visualDocuments.clear()
    documentFailed = false
    loadState.reset()
    val view = webView
    if (view == null) {
      // A dead renderer requires a remount; changed props must still report failure.
      emit(loadState.rendererStillGone())
      return
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
    if (!applyBridgeListener(view, origin, bridgeEnabled)) {
      failPropUpdate(MobileWebShellFailureReason.ISOLATION_UNAVAILABLE)
      return
    }
    served = MobileWebShellServed(loaded, host)
    view.visibility = View.VISIBLE
    view.loadUrl("$origin/")
  }

  /** Retire the old visible generation even when the replacement fails. */
  private fun failPropUpdate(reason: MobileWebShellFailureReason) {
    // Remove the old listener: stopLoading leaves its same-origin document alive and able to rearm replies.
    removeBridgeListener()
    served = null
    webView?.visibility = View.INVISIBLE
    emit(loadState.failed(reason))
  }

  /** addWebMessageListener injects before scripts and enforces origins; false means unsupported provider. */
  private fun applyBridgeListener(view: WebView, origin: String, bridgeEnabled: Boolean): Boolean {
    removeBridgeListener()
    val outcome = mobileWebShellBridgeInstall(
      bridgeEnabled,
      WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
    )
    if (outcome != MobileWebShellBridgeInstall.INSTALL) {
      return outcome == MobileWebShellBridgeInstall.SKIP
    }
    return runCatching {
      WebViewCompat.addWebMessageListener(
        view,
        MOBILE_WEB_SHELL_BRIDGE_OBJECT,
        setOf(origin),
        bridgeListener
      )
      bridgeInstalled = true
    }.isSuccess
  }

  /** The one way the bridge goes away, so no disable path can leave a listener behind. */
  private fun removeBridgeListener() {
    val view = webView
    if (bridgeInstalled && view != null) {
      WebViewCompat.removeWebMessageListener(view, MOBILE_WEB_SHELL_BRIDGE_OBJECT)
    }
    bridgeInstalled = false
    replyProxy = null
  }

  /** Chromium calls this on the UI thread, which is also the only thread that may reply. */
  private val bridgeListener = WebViewCompat.WebMessageListener {
    _, message, _, isMainFrame, proxy ->
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
      sink?.documentBridgeMessage(json)
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

  /** A frame from the shell itself, to the frame that spoke. */
  fun postHostFrame(json: String) {
    replyProxy?.postMessage(json)
  }

  /** The view's attach and detach: off-window, the page reads hidden, as a buried WKWebView does on iOS. */
  fun resume() {
    webView?.onResume()
  }

  fun pause() {
    webView?.onPause()
  }

  /** The view is done with it, or onRenderProcessGone. */
  fun destroyWebView() {
    val view = webView ?: return
    removeBridgeListener()
    loadState.documentEnded()
    webView = null
    blocker?.remove()
    blocker = null
    served = null
    visualDocuments.clear()
    documentFailed = false
    view.stopLoading()
    (view.parent as? ViewGroup)?.removeView(view)
    view.destroy()
  }

  fun createVisualDocument(html: String): String {
    check(isUsable && served != null && loadState.hasCommittedDocument)
    val origin = mobileWebShellOrigin(applied?.sessionId ?: "") ?: error("No visual document origin")
    return origin + visualDocuments.create(html)
  }

  fun releaseVisualDocument(url: String) {
    visualDocumentPath(Uri.parse(url))?.let(visualDocuments::remove)
  }

  private fun visualDocumentPath(url: Uri): String? {
    val host = served?.originHost ?: return null
    val parts = requestParts(url).copy(fragment = null)
    val path = resolveMobileWebShellRequestPath(parts, host) ?: return null
    return if (visualDocuments.read(path) != null) path else null
  }

  // Keep explicit settings even where newer WebViews ignore deprecated options; the floor is Chromium 101.
  // B4 requires device proofs: no network, persistent state, file/content access, cleartext or navigation escape.
  @Suppress("DEPRECATION")
  private fun createWebView(): WebView {
    val view = MobileWebShellSelectionView(context)
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
    if (emission != null) sink?.documentLoadState(emission.toPayload())
  }

  /** Post hiding past Chromium’s error-document commit; interception may also run off the main thread. */
  private fun reportDocumentFailure() {
    replyProxy = null
    // Drop replies synchronously before Chromium’s error document commits and the posted hide runs.
    loadState.documentEnded()
    // Set before posting: intervening onPageFinished must not restore ready or expose the error page.
    documentFailed = true
    val epoch = loadState.epoch
    // The WebView's queue, like the view it sits in: a detached document reports once it attaches.
    webView?.post {
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

  private fun serveRequest(request: WebResourceRequest): WebResourceResponse? {
    val current = served ?: return null
    val parts = requestParts(
      request.url,
      method = request.method,
      hasRangeHeader = request.requestHeaders.keys.any { it.equals("Range", ignoreCase = true) }
    )
    val path = resolveMobileWebShellRequestPath(parts, current.originHost) ?: return null
    if (path.startsWith(MOBILE_WEB_SHELL_VISUAL_PREFIX)) {
      if (request.isForMainFrame) return null
      val bytes = visualDocuments.read(path) ?: return null
      return WebResourceResponse("text/html", "utf-8", 200, "OK",
        mobileWebShellResponseHeaders(path, bytes.size), ByteArrayInputStream(bytes))
    }
    val asset = current.generation.entries[path] ?: return null
    val bytes = runCatching { asset.file.readBytes() }.getOrNull() ?: return null
    val headers = mobileWebShellResponseHeaders(path, bytes.size)
    val (mimeType, charset) = splitMobileWebShellContentType(asset.contentType)
    return WebResourceResponse(mimeType, charset, 200, "OK", headers, ByteArrayInputStream(bytes))
  }

  private fun refusedResponse(): WebResourceResponse = WebResourceResponse(
    MOBILE_WEB_SHELL_REFUSAL_MIME_TYPE,
    MOBILE_WEB_SHELL_REFUSAL_CHARSET,
    MOBILE_WEB_SHELL_REFUSAL_STATUS,
    MOBILE_WEB_SHELL_REFUSAL_REASON,
    MOBILE_WEB_SHELL_REFUSAL_HEADERS,
    ByteArrayInputStream(mobileWebShellRefusalBody())
  )

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
      if (!request.isForMainFrame && visualDocumentPath(request.url) != null) return false
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
        sink?.documentExternalNavigation(verdict.url)
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
      // Android ends every WebView's renderer together; off-screen or low-memory losses are the OS's doing, not the page's.
      val host = view.parent as? View ?: view
      val background = !host.isShown || host.windowVisibility != View.VISIBLE
      destroyWebView()
      emit(loadState.rendererGone(background, detail.didCrash()))
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
