package expo.modules.orcamobilewebshell

import android.content.Context
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/** CSP fences fetch/XHR; document-start script blocks unobservable WebSocket handshakes and
 * service workers whose native switch is process-global. Keep iOS in sync; both non-configurable
 * and non-writable are needed to prevent page replacement. */
internal val MOBILE_WEB_SHELL_NETWORK_API_BLOCKER = """
  (function(){
  var deny=function(){throw new TypeError('Network access is disabled')};
  try{Object.defineProperty(globalThis,'WebSocket',{value:deny,configurable:false,writable:false})}catch(_){}
  try{Object.defineProperty(Navigator.prototype,'serviceWorker',{get:function(){return undefined},configurable:false})}catch(_){}
  try{Object.defineProperty(navigator,'serviceWorker',{value:undefined,configurable:false,writable:false})}catch(_){}
  })();
""".trimIndent()

/** Where the page-script fallback serves the blocker. Reserved ahead of generation assets, like the chat visual frame. */
internal const val MOBILE_WEB_SHELL_NETWORK_API_BLOCKER_PATH = "/orca-network-api-blocker.js"

/** Oldest Chromium the page was run on (Huawei/Honor WebView 14 is 99); es2022 syntax needs 94. */
private const val MOBILE_WEB_SHELL_MIN_PAGE_SCRIPT_CHROMIUM = 99

internal enum class MobileWebShellNetworkFence {
  /** addDocumentStartJavaScript: every same-origin frame, before any of its scripts. */
  DOCUMENT_START_SCRIPT,

  /** The document's first script. Covers the main frame only; the CSP still fences every frame. */
  PAGE_SCRIPT,
  UNAVAILABLE
}

/** Query capability first. Vendor WebViews number packages apart from Chromium, so the fallback reads the UA's Chrome/ token. */
internal fun mobileWebShellNetworkFence(context: Context): MobileWebShellNetworkFence {
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
    return MobileWebShellNetworkFence.UNAVAILABLE
  }
  if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
    return MobileWebShellNetworkFence.DOCUMENT_START_SCRIPT
  }
  val userAgent = runCatching { WebSettings.getDefaultUserAgent(context) }.getOrNull()
  val major = userAgent?.let { CHROME_MAJOR.find(it)?.groupValues?.get(1)?.toIntOrNull() }
  return if (major != null && major >= MOBILE_WEB_SHELL_MIN_PAGE_SCRIPT_CHROMIUM) {
    MobileWebShellNetworkFence.PAGE_SCRIPT
  } else {
    MobileWebShellNetworkFence.UNAVAILABLE
  }
}

private val CHROME_MAJOR = Regex("""Chrome/(\d+)\.""")

internal val MOBILE_WEB_SHELL_NETWORK_API_BLOCKER_BYTES =
  MOBILE_WEB_SHELL_NETWORK_API_BLOCKER.toByteArray(Charsets.UTF_8)

private val LEADING_DOCTYPE = Regex("^\uFEFF?\\s*<!doctype[^>]*>", RegexOption.IGNORE_CASE)

/** Make the blocker the document's first token after the doctype, so no comment or earlier script can precede it.
 * The parser opens html and head around it; the document's own <html> attributes still apply. */
internal fun withMobileWebShellNetworkApiBlockerScript(document: ByteArray): ByteArray {
  val html = document.toString(Charsets.UTF_8)
  val insertAt = LEADING_DOCTYPE.find(html)?.range?.last?.plus(1) ?: 0
  val tag = "<script src=\"$MOBILE_WEB_SHELL_NETWORK_API_BLOCKER_PATH\"></script>"
  return (html.substring(0, insertAt) + tag + html.substring(insertAt)).toByteArray(Charsets.UTF_8)
}

/** Requires DOCUMENT_START_SCRIPT; stable WebView has it from Chromium 101. */
internal fun installMobileWebShellNetworkApiBlocker(
  webView: WebView,
  allowedOrigin: String
): ScriptHandler? {
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return null
  return runCatching {
    WebViewCompat.addDocumentStartJavaScript(
      webView,
      MOBILE_WEB_SHELL_NETWORK_API_BLOCKER,
      setOf(allowedOrigin)
    )
  }.getOrNull()
}
