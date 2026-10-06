package expo.modules.orcamobilewebshell

import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * CSP is the fence for fetch and XMLHttpRequest. This script exists only for the two things the
 * native layer is never shown: a WebSocket handshake, which neither `blockNetworkLoads` nor
 * `shouldInterceptRequest` sees, and a service worker registration, whose only native control is
 * process-global and would reconfigure the app's other WebViews. Kept in step with the iOS copy.
 * `configurable: false` with `writable: false` is the only property shape the page cannot put back.
 */
internal val MOBILE_WEB_SHELL_NETWORK_API_BLOCKER = """
  (function(){
  var deny=function(){throw new TypeError('Network access is disabled')};
  try{Object.defineProperty(globalThis,'WebSocket',{value:deny,configurable:false,writable:false})}catch(_){}
  try{Object.defineProperty(Navigator.prototype,'serviceWorker',{get:function(){return undefined},configurable:false})}catch(_){}
  try{Object.defineProperty(navigator,'serviceWorker',{value:undefined,configurable:false,writable:false})}catch(_){}
  })();
""".trimIndent()

/**
 * Null when the WebView provider is older than the document-start script feature (Chromium 83).
 * The feature query is the capability; a version string is not, so nothing here parses one.
 */
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
