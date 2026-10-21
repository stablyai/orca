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

    private object ParkedWebViewClient : WebViewClient() {
      override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest
      ): WebResourceResponse =
        WebResourceResponse(
          "text/plain",
          "utf-8",
          403,
          "Forbidden",
          emptyMap(),
          ByteArrayInputStream(ByteArray(0))
        )

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        true

      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        retainedPool.clear()
        return true
      }
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
  private var bridgeInstalled = false
  private var bridgeChannel: MobileWebShellBridgeChannel? = null
  private val bridgeGate = MobileWebShellBridgeGate()
  // Chromium hands a reply proxy to the listener, so native cannot speak first. The envelope has
  // the page send `ready` before anything is delivered, so there is nothing to speak first about.
  // Volatile for the same reason as `documentFailed`: `reportDocumentFailure` drops the proxy from
  // whichever thread `shouldInterceptRequest` ran on, and the listener reads it on the UI thread.
  @Volatile private var replyProxy: JavaScriptReplyProxy? = null
  private var applied: MobileWebShellAppliedProps? = null
  private val loadState = MobileWebShellLoadStateMachine()
  // Written on the main thread, read from onPageStarted/onPageFinished, which Chromium runs after
  // the failure that hid the view; `shouldInterceptRequest` also runs off the main thread.
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
    // The listener outlives the props it was installed under, and the document it was installed
    // for is still alive after `stopLoading`: left in place it would keep posting through an
    // origin this mount has just stopped serving, and re-arm the reply proxy doing it.
    removeBridgeListener()
    served = null
    webView?.visibility = View.INVISIBLE
    emit(loadState.failed(reason))
  }

  /**
   * `addWebMessageListener` is the whole install: Chromium injects an `orcaBridge` object of the
   * agreed shape before any page script runs, and enforces the allowed origin itself, which is why
   * the listener needs no origin check of its own. Answers false only for a provider too old to
   * offer the listener at all.
   */
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

  /**
   * Thrown rather than dropped: the only caller is the React Native host, and a silent drop would
   * turn a chunking bug there into a request that never settles.
   */
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
      view.webViewClient = ParkedWebViewClient
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

  // databaseEnabled and the two file-URL settings are deprecated and inert on new WebViews, but
  // the floor here is Chromium 83, and an invariant left to a default is one nobody can read.
  //
  // device-checked in B4: no setting below can be proven from a JVM test, and neither can
  // shouldOverrideUrlLoading dropping a navigation. Confirm on a device that a page cannot reach
  // the network (blockNetworkLoads), cannot keep state across a remount (domStorageEnabled,
  // databaseEnabled, cacheMode), cannot read a file or a content provider (allowFileAccess,
  // allowContentAccess, the two file-URL settings), cannot load http (mixedContentMode), and
  // cannot navigate away from the document.
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
    // Replaces WebView's own inset handling (its listener on P–R, onApplyWindowInsets on S+);
    // forwarding the zeroed set keeps S+ in step.
    ViewCompat.setOnApplyWindowInsetsListener(view) { target, insets ->
      ViewCompat.onApplyWindowInsets(target, insetsForShellPage(insets))
    }
    return view
  }

  private fun emit(emission: MobileWebShellLoadEmission?) {
    if (emission != null) onLoadState(emission.toPayload())
  }

  /**
   * Chromium commits its own error document after `onReceivedError` returns, so hiding the WebView
   * synchronously is undone a moment later; posting is what keeps the shell's own state the only
   * thing on screen. `shouldInterceptRequest` also runs off the main thread.
   */
  private fun reportDocumentFailure() {
    replyProxy = null
    // Synchronously, unlike the emission: the error document commits before the post runs, and a
    // page that failed is not one to hear from in the meantime.
    loadState.documentEnded()
    // Set before the post, not inside it: onPageFinished runs in between and would otherwise
    // report `ready` over the failure and make the error page visible again.
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
      // `hasGesture` decides only what may be offered to the opener. Nothing is allowed on the
      // strength of it: Chromium is permitted to report false for a request a human started, and a
      // subframe can navigate the top frame with no gesture at all.
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
        // Always false, and it is the platform that says so. WebViewClient's own javadoc: "This
        // callback is not called for all page navigations. In particular, this is not called for
        // navigations which the app initiated with loadUrl(): this callback would not serve a purpose
        // in this case, because the app already knows about the navigation." So there is no own-load
        // window here to keep a flag for, and nothing reaching this callback is the shell's own load.
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
      // The document that spoke is being replaced, so its proxy stops being somewhere to post: the
      // next one has to say `ready` first, which is what the envelope has it do.
      replyProxy = null
      loadState.documentEnded()
      if (documentFailed || !isDocumentUrl(Uri.parse(url))) return
      // The load the caller was told about is the one now on screen, so this is where the page
      // becomes something to hear. Chromium runs page script after this.
      loadState.committed()
      emit(loadState.started())
    }

    // No URL check: the page rewrites its own path with history.replaceState before its first
    // render, so the document that committed at "/" finishes at the route it opened. What is left
    // is whether this is the document the caller was told about, which is what committing means.
    override fun onPageFinished(view: WebView, url: String) {
      if (documentFailed || !loadState.hasCommittedDocument) return
      view.visibility = View.VISIBLE
      // After the rewrite as well as before it: the back-forward list is the page's, and the shell
      // gives it no way back to a document it has already replaced.
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

    /**
     * Returning false would kill the app. The dead WebView is destroyed and not rebuilt: renderer
     * memory pressure, a provider update and a bad bundle are indistinguishable here, so the retry
     * policy is the caller's and lives in one place.
     */
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

/**
 * The shell pads the bars and shortens the WebView for the keyboard, so WebView M144+ forwarding
 * systemBars/displayCutout to env(safe-area-inset-*), and M139+ resizing for ime(), pad twice.
 * Zeroed, never CONSUMED, so later changes still arrive (Android "Understand window insets in WebView").
 */
private fun insetsForShellPage(insets: WindowInsetsCompat): WindowInsetsCompat =
  WindowInsetsCompat.Builder(insets)
    .setInsets(SHELL_OWNED_INSET_TYPES, Insets.NONE)
    .build()

private val SHELL_OWNED_INSET_TYPES =
  WindowInsetsCompat.Type.systemBars() or
    WindowInsetsCompat.Type.displayCutout() or
    WindowInsetsCompat.Type.ime()
