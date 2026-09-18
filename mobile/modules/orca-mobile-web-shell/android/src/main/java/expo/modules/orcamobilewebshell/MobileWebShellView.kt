package expo.modules.orcamobilewebshell

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Message
import android.view.View
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ScriptHandler
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.ByteArrayInputStream

@SuppressLint("ViewConstructor", "SetJavaScriptEnabled")
internal class OrcaMobileWebShellView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  private val onLoadState by EventDispatcher<Map<String, Any>>()

  private var generationDirectory = ""
  private var sessionId = ""
  private var appliedDirectory: String? = null
  private var appliedSessionId: String? = null
  private var failureReported = false
  private var generation: MobileWebShellGeneration? = null
  private var originHost: String? = null
  private var blocker: ScriptHandler? = null
  private var webView: WebView? = createWebView()

  init {
    addView(webView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun setGenerationDirectory(value: String) {
    generationDirectory = value
  }

  fun setSessionId(value: String) {
    sessionId = value
  }

  /**
   * Props arrive in no defined order, so neither setter starts anything; this does, once both are
   * in. A repeat of the same pair is not a retry: a retry is a remount under a new React key.
   */
  fun propsDidUpdate() {
    if (generationDirectory == appliedDirectory && sessionId == appliedSessionId) return
    appliedDirectory = generationDirectory
    appliedSessionId = sessionId
    failureReported = false
    val view = webView ?: return
    view.stopLoading()
    report("loading")

    val origin = mobileWebShellOrigin(sessionId)
    val host = mobileWebShellOriginHost(sessionId)
    if (origin == null || host == null) {
      // The private origin is the isolation primitive; a malformed session id leaves us without one.
      report("failed", "isolation-unavailable")
      return
    }
    val loaded = MobileWebShellGeneration.load(generationDirectory)
    if (loaded == null) {
      report("failed", "generation-unreadable")
      return
    }
    blocker?.remove()
    blocker = installMobileWebShellNetworkApiBlocker(view, origin)
    if (blocker == null) {
      report("failed", "isolation-unavailable")
      return
    }
    generation = loaded
    originHost = host
    view.visibility = View.VISIBLE
    view.loadUrl("$origin/")
  }

  /** Expo calls this once React Native is done with the view; the renderer only dies here. */
  fun destroyWebView() {
    val view = webView ?: return
    webView = null
    blocker?.remove()
    blocker = null
    generation = null
    originHost = null
    view.stopLoading()
    removeView(view)
    view.destroy()
  }

  // databaseEnabled is deprecated and inert on new WebViews, but the floor here is Chromium 83.
  @Suppress("DEPRECATION")
  private fun createWebView(): WebView {
    val view = WebView(context)
    view.setBackgroundColor(Color.TRANSPARENT)
    view.settings.apply {
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
    }
    // Never clearCache(true): that is process-global and would wipe the HTTP cache of every other
    // WebView in the app, including the terminal's. LOAD_NO_CACHE plus no-store is per view.
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
    return view
  }

  private fun report(state: String, reason: String? = null) {
    val payload = if (reason == null) {
      mapOf("state" to state)
    } else {
      mapOf("state" to state, "reason" to reason)
    }
    onLoadState(payload)
  }

  /**
   * Chromium commits its own error document after `onReceivedError` returns, so hiding the WebView
   * synchronously is undone a moment later; posting is what keeps the shell's own state the only
   * thing on screen. `shouldInterceptRequest` also runs off the main thread.
   */
  private fun reportDocumentFailure() {
    post {
      if (failureReported) return@post
      failureReported = true
      webView?.visibility = View.INVISIBLE
      report("failed", "document-load-failed")
    }
  }

  private fun isDocumentUrl(url: Uri): Boolean {
    val host = originHost ?: return false
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
    val host = originHost ?: return null
    val entries = generation?.entries ?: return null
    val parts = requestParts(
      request.url,
      method = request.method,
      hasRangeHeader = request.requestHeaders.keys.any { it.equals("Range", ignoreCase = true) }
    )
    val path = resolveMobileWebShellRequestPath(parts, host) ?: return null
    val asset = entries[path] ?: return null
    val bytes = runCatching { asset.file.readBytes() }.getOrNull() ?: return null
    val headers = mutableMapOf(
      "Content-Length" to bytes.size.toString(),
      "Cache-Control" to "no-store",
      "X-Content-Type-Options" to "nosniff"
    )
    if (path == "/") {
      headers["Content-Security-Policy"] = MOBILE_WEB_SHELL_CSP
    }
    val (mimeType, charset) = splitMobileWebShellContentType(asset.contentType)
    return WebResourceResponse(mimeType, charset, 200, "OK", headers, ByteArrayInputStream(bytes))
  }

  private fun refusedResponse(): WebResourceResponse = WebResourceResponse(
    "text/plain",
    "utf-8",
    403,
    "Forbidden",
    mapOf("Cache-Control" to "no-store"),
    ByteArrayInputStream(ByteArray(0))
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

    /** True means the navigation is dropped; only the document URL is ever allowed to load. */
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
      !(request.isForMainFrame && isDocumentUrl(request.url))

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
      if (!isDocumentUrl(Uri.parse(url))) return
      report("loading")
    }

    override fun onPageFinished(view: WebView, url: String) {
      if (!isDocumentUrl(Uri.parse(url))) return
      view.visibility = View.VISIBLE
      view.clearHistory()
      report("ready")
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

    /**
     * Returning false would kill the app. The dead WebView is destroyed and not rebuilt: renderer
     * memory pressure, a provider update and a bad bundle are indistinguishable here, so the retry
     * policy is the caller's and lives in one place.
     */
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      destroyWebView()
      report("failed", "render-process-gone")
      return true
    }
  }
}
