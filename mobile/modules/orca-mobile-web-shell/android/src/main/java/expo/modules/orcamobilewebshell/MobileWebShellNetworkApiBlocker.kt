package expo.modules.orcamobilewebshell

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

/** Query document-start-script capability (Chromium 83 floor), not version strings. */
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
