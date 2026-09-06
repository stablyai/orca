package expo.modules.mobilewebshell

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.view.View
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.ByteArrayInputStream

internal const val MOBILE_WEB_ORIGIN_SCHEME = "https"
internal const val MOBILE_WEB_ORIGIN_HOST = "orca-mobile-web.invalid"
internal const val MOBILE_WEB_ORIGIN = "$MOBILE_WEB_ORIGIN_SCHEME://$MOBILE_WEB_ORIGIN_HOST"
private const val MOBILE_WEB_BRIDGE_NAME = "OrcaNative"
private const val MOBILE_WEB_MERMAID_FRAME_PATH = "mermaid-frame.html"
private const val MOBILE_WEB_MESSAGE_BYTE_LIMIT = 640 * 1024
private const val MOBILE_WEB_PENDING_MESSAGE_LIMIT = 32
private val MOBILE_WEB_CSP = listOf(
  "default-src 'none'",
  "script-src 'self' 'sha256-9WQo6QEeDR1Qf5aOmvWdM6FJv6hDF22Gbk7IKakIW4A='",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'self' data:",
  "child-src 'self' data:",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
).joinToString("; ")
private val MOBILE_WEB_MERMAID_FRAME_CSP = listOf(
  "default-src 'none'",
  "script-src 'sha256-JHwlo5V7HtwqexHUhXguW04dF71kAVlQOX1QdtyCkjg=' blob:",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src 'none'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'"
).joinToString("; ")

@SuppressLint("ViewConstructor", "SetJavaScriptEnabled")
internal class MobileWebShellView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  private val onBridgeMessage by EventDispatcher<Map<String, Any>>()
  private val onNavigationBlocked by EventDispatcher<Map<String, Any>>()
  private val onProcessTerminated by EventDispatcher<Map<String, Any>>()
  private val onLoadState by EventDispatcher<Map<String, Any>>()
  private val packageStore = MobileWebShellEnvironment.packageStore(context)
  private var activeSessionId: String? = null
  private var documentLoaded = false
  private var networkBlockerScriptHandler: ScriptHandler? = null
  private var debugProbeScriptHandler: ScriptHandler? = null
  private var bridgeMessageListenerAttached = false
  private var destroyed = false
  private var webView: WebView

  init {
    webView = createWebView()
    attachWebView()
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun createWebView(): WebView {
    val webView = WebView(context)
    webView.setBackgroundColor(Color.TRANSPARENT)
    webView.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = false
      databaseEnabled = false
      allowFileAccess = false
      allowContentAccess = false
      javaScriptCanOpenWindowsAutomatically = false
      setSupportMultipleWindows(false)
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      cacheMode = WebSettings.LOAD_NO_CACHE
      blockNetworkLoads = true
      mediaPlaybackRequiresUserGesture = true
      setGeolocationEnabled(false)
      saveFormData = false
    }
    webView.clearCache(true)
    webView.webViewClient = LockedWebViewClient()
    webView.webChromeClient = object : WebChromeClient() {
      override fun onCreateWindow(
        view: WebView?,
        isDialog: Boolean,
        isUserGesture: Boolean,
        resultMsg: android.os.Message?
      ): Boolean = false
    }
    webView.setDownloadListener { url, _, _, _, _ ->
      onNavigationBlocked(mapOf("url" to url.orEmpty().take(2_048)))
    }
    return webView
  }

  private fun attachWebView() {
    if (webView.parent == null) {
      addView(webView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }
  }

  fun setSessionId(sessionId: String?) {
    if (destroyed) return
    if (sessionId == null) {
      deactivateSessionView()
      return
    }
    if (sessionId == activeSessionId) return
    activeSessionId = sessionId
    documentLoaded = false
    networkBlockerScriptHandler?.remove()
    networkBlockerScriptHandler = installMobileWebNetworkApiBlocker(
      webView,
      mobileWebOriginForSession(sessionId)
    )
    debugProbeScriptHandler?.remove()
    debugProbeScriptHandler = installMobileWebDebugIsolationProbe(
      webView,
      appContext,
      mobileWebOriginForSession(sessionId)
    )
    removeBridgeMessageListener()
    addBridgeMessageListener(sessionId)
    webView.stopLoading()
    attachWebView()
    visibility = View.VISIBLE
    webView.visibility = View.VISIBLE
    onLoadState(mapOf("state" to "loading"))
    webView.loadUrl("${mobileWebOriginForSession(sessionId)}/#$sessionId")
  }

  fun activateSessionView(sessionId: String) {
    setSessionId(sessionId)
  }

  fun deactivateSessionView() {
    if (destroyed) return
    removeBridgeMessageListener()
    networkBlockerScriptHandler?.remove()
    networkBlockerScriptHandler = null
    debugProbeScriptHandler?.remove()
    debugProbeScriptHandler = null
    activeSessionId = null
    documentLoaded = false
    webView.stopLoading()
    visibility = View.INVISIBLE
    webView.visibility = View.INVISIBLE
    webView.loadUrl("about:blank")
    removeView(webView)
  }

  fun postMessage(message: String) {
    require(message.toByteArray(Charsets.UTF_8).size <= MOBILE_WEB_MESSAGE_BYTE_LIMIT) {
      "mobile_web_bridge_message_too_large"
    }
    if (destroyed) return
    webView.evaluateJavascript(
      """
      (function(value){
        if(window.__orcaMobileWebShellListening===true){
          window.dispatchEvent(new MessageEvent('message',{data:value}));
          return;
        }
        var pending=window.__orcaMobileWebShellPending;
        if(!Array.isArray(pending)) pending=window.__orcaMobileWebShellPending=[];
        if(pending.length<$MOBILE_WEB_PENDING_MESSAGE_LIMIT) pending.push(value);
      })(${JSONObjectQuote.quote(message)})
      """.trimIndent(),
      null
    )
  }

  fun postMessageIfActive(sessionId: String, message: String) {
    if (activeSessionId == sessionId) postMessage(message)
  }

  /**
   * Detaching only parks the WebView — a deactivated view is reactivated in place — so the renderer
   * process, the JavaScript context and both script handlers only go away here. Expo calls this once
   * the view is unmounted, which is what a package swap, a host switch and a route exit all do.
   */
  fun destroy() {
    if (destroyed) return
    destroyed = true
    removeBridgeMessageListener()
    networkBlockerScriptHandler?.remove()
    networkBlockerScriptHandler = null
    debugProbeScriptHandler?.remove()
    debugProbeScriptHandler = null
    activeSessionId = null
    documentLoaded = false
    webView.stopLoading()
    webView.loadUrl("about:blank")
    removeView(webView)
    webView.destroy()
  }

  override fun onDetachedFromWindow() {
    removeBridgeMessageListener()
    if (!destroyed) webView.stopLoading()
    super.onDetachedFromWindow()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (destroyed) return
    attachWebView()
    val sessionId = activeSessionId ?: return
    addBridgeMessageListener(sessionId)
    visibility = View.VISIBLE
    webView.visibility = View.VISIBLE
    val currentUrl = webView.url?.let(Uri::parse)
    if (!documentLoaded || currentUrl == null || !isAllowedDocumentUrl(currentUrl)) {
      webView.stopLoading()
      onLoadState(mapOf("state" to "loading"))
      webView.loadUrl("${mobileWebOriginForSession(sessionId)}/#$sessionId")
    }
  }

  private fun removeBridgeMessageListener() {
    if (!bridgeMessageListenerAttached) return
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      WebViewCompat.removeWebMessageListener(webView, MOBILE_WEB_BRIDGE_NAME)
    }
    bridgeMessageListenerAttached = false
  }

  private fun addBridgeMessageListener(sessionId: String) {
    if (bridgeMessageListenerAttached) return
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      WebViewCompat.addWebMessageListener(
        webView,
        MOBILE_WEB_BRIDGE_NAME,
        setOf(mobileWebOriginForSession(sessionId)),
        OriginLockedMessageListener()
      )
      bridgeMessageListenerAttached = true
    } else {
      throw IllegalStateException("mobile_web_bridge_origin_enforcement_unavailable")
    }
  }

  private inner class OriginLockedMessageListener : WebViewCompat.WebMessageListener {
    override fun onPostMessage(
      view: WebView,
      message: androidx.webkit.WebMessageCompat,
      sourceOrigin: Uri,
      isMainFrame: Boolean,
      replyProxy: JavaScriptReplyProxy
    ) {
      val body = message.data ?: return
      val sessionId = activeSessionId ?: return
      val documentUrl = view.url?.let(Uri::parse) ?: return
      if (
        !isMainFrame ||
        !isMobileWebOriginForSession(sourceOrigin, sessionId) ||
        !isAllowedMobileWebBridgeDocumentUrl(documentUrl.toString(), sessionId) ||
        body.toByteArray(Charsets.UTF_8).size > MOBILE_WEB_MESSAGE_BYTE_LIMIT
      ) return
      onBridgeMessage(mapOf("data" to body))
    }
  }

  private inner class LockedWebViewClient : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
      return runCatching { serveRequest(request) }.getOrElse { error ->
        if (request.isForMainFrame) {
          // Chromium turns a non-2xx main-frame response into its own error page, so the shell has
          // to name the reason itself before that page replaces the document.
          reportDocumentFailure(error.message ?: "mobile_web_document_unavailable")
        }
        blockedResponse()
      }
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
      val url = request.url
      if (!request.isForMainFrame && url.scheme == "data") return false
      if (!request.isForMainFrame && isAllowedEmbeddedDocumentUrl(url)) return false
      val allowed = request.isForMainFrame && isAllowedDocumentUrl(url)
      if (!allowed) {
        onNavigationBlocked(mapOf("url" to url.toString().take(2_048)))
      }
      return !allowed
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
      // The page can replace its own document (the route error boundary reloads on a failed chunk),
      // and that is the only signal the shell gets. Every load start is reported so the shell can
      // retire the outgoing page's grants before the new document initializes.
      if (!isAllowedDocumentRequestUrl(Uri.parse(url))) return
      documentLoaded = false
      onLoadState(mapOf("state" to "loading"))
    }

    override fun onPageFinished(view: WebView, url: String) {
      if (isAllowedDocumentUrl(Uri.parse(url))) {
        documentLoaded = true
        view.visibility = View.VISIBLE
        view.clearHistory()
        onLoadState(mapOf("state" to "loaded"))
      }
    }

    override fun onReceivedError(
      view: WebView,
      request: WebResourceRequest,
      error: android.webkit.WebResourceError
    ) {
      if (request.isForMainFrame && isAllowedDocumentRequestUrl(request.url)) {
        reportDocumentFailure("mobile_web_document_load_error_${error.errorCode}")
      }
    }

    override fun onReceivedHttpError(
      view: WebView,
      request: WebResourceRequest,
      errorResponse: WebResourceResponse
    ) {
      if (request.isForMainFrame && isAllowedDocumentRequestUrl(request.url)) {
        reportDocumentFailure("mobile_web_document_http_${errorResponse.statusCode}")
      }
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      onProcessTerminated(mapOf("sessionId" to (activeSessionId ?: "")))
      removeBridgeMessageListener()
      networkBlockerScriptHandler?.remove()
      networkBlockerScriptHandler = null
      debugProbeScriptHandler?.remove()
      debugProbeScriptHandler = null
      removeView(view)
      view.destroy()
      webView = createWebView()
      documentLoaded = false
      attachWebView()
      val sessionId = activeSessionId
      if (sessionId != null) {
        networkBlockerScriptHandler = installMobileWebNetworkApiBlocker(
          webView,
          mobileWebOriginForSession(sessionId)
        )
        addBridgeMessageListener(sessionId)
        webView.visibility = View.VISIBLE
        onLoadState(mapOf("state" to "loading"))
        webView.loadUrl("${mobileWebOriginForSession(sessionId)}/#$sessionId")
      }
      return true
    }
  }

  /** Hides the Chromium error page and hands the RN shell a reason it can show instead. */
  private fun reportDocumentFailure(reason: String) {
    post {
      documentLoaded = false
      webView.visibility = View.INVISIBLE
      onLoadState(mapOf("state" to "failed", "reason" to reason.take(128)))
    }
  }

  private fun serveRequest(request: WebResourceRequest): WebResourceResponse {
    val url = request.url
    val sessionId = activeSessionId
    require(
      request.method == "GET" &&
        request.requestHeaders.keys.none { it.equals("Range", ignoreCase = true) } &&
        sessionId != null &&
        isMobileWebOriginForSession(url, sessionId) &&
        (url.fragment == null || (request.isForMainFrame && url.fragment == sessionId)) &&
        url.query == null &&
        !url.encodedPath.orEmpty().contains('%') &&
        url.toString().length <= 8 * 1024
    ) { "mobile_web_asset_request_invalid" }
    val requestPath = url.path.orEmpty().trimStart('/')
    val path = if (requestPath.isEmpty()) "index.html" else requestPath
    val asset = packageStore.readAsset(sessionId, path)
    val contentTypeParts = asset.contentType.split("; charset=", limit = 2)
    val headers = mutableMapOf(
      "Content-Length" to asset.bytes.size.toString(),
      "Cache-Control" to "no-store",
      "X-Content-Type-Options" to "nosniff"
    )
    if (asset.isDocument) {
      headers["Content-Security-Policy"] =
        if (path == MOBILE_WEB_MERMAID_FRAME_PATH) MOBILE_WEB_MERMAID_FRAME_CSP else MOBILE_WEB_CSP
    }
    return WebResourceResponse(
      contentTypeParts[0],
      contentTypeParts.getOrNull(1),
      200,
      "OK",
      headers,
      ByteArrayInputStream(asset.bytes)
    )
  }

  private fun isAllowedDocumentUrl(url: Uri): Boolean {
    val sessionId = activeSessionId ?: return false
    return isMobileWebOriginForSession(url, sessionId) &&
      url.path == "/" &&
      url.encodedPath == "/" &&
      url.query == null &&
      url.fragment == sessionId &&
      url.toString().length <= 8 * 1024
  }

  private fun isAllowedDocumentRequestUrl(url: Uri): Boolean {
    val sessionId = activeSessionId ?: return false
    return isMobileWebOriginForSession(url, sessionId) &&
      url.path == "/" &&
      url.encodedPath == "/" &&
      url.query == null &&
      (url.fragment == null || url.fragment == sessionId) &&
      url.toString().length <= 8 * 1024
  }

  private fun isAllowedEmbeddedDocumentUrl(url: Uri): Boolean {
    val sessionId = activeSessionId ?: return false
    return isMobileWebOriginForSession(url, sessionId) &&
      url.path == "/$MOBILE_WEB_MERMAID_FRAME_PATH" &&
      url.encodedPath == "/$MOBILE_WEB_MERMAID_FRAME_PATH" &&
      url.query == null &&
      url.fragment == null &&
      url.toString().length <= 8 * 1024
  }

  private fun blockedResponse(): WebResourceResponse = WebResourceResponse(
    "text/plain",
    "UTF-8",
    403,
    "Forbidden",
    mapOf("Cache-Control" to "no-store"),
    ByteArrayInputStream(ByteArray(0))
  )
}

private object JSONObjectQuote {
  fun quote(value: String): String = org.json.JSONObject.quote(value)
}
