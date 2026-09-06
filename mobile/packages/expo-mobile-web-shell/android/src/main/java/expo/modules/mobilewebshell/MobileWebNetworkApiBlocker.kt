package expo.modules.mobilewebshell

import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

// Kept byte-identical to mobileWebNetworkApiBlocker in ios/MobileWebShellView.swift; blockNetworkLoads
// and shouldInterceptRequest never see WebSocket, so the page-side denial is the only parity fence.
internal val MOBILE_WEB_NETWORK_API_BLOCKER = """
    (function(){
    Object.defineProperties(globalThis,{
      fetch:{
        value:function(){return Promise.reject(new TypeError('Network access is disabled'))},
        configurable:false,
        writable:false
      },
      XMLHttpRequest:{
        value:function(){throw new TypeError('Network access is disabled')},
        configurable:false,
        writable:false
      },
      WebSocket:{
        value:function(){throw new TypeError('Network access is disabled')},
        configurable:false,
        writable:false
      }
    });
    try {
      var nativeNavigator=globalThis.navigator;
      var restrictedNavigator=new Proxy(nativeNavigator,{
        get:function(target,property){
          if(property==='serviceWorker') return undefined;
          return Reflect.get(target,property,target);
        }
      });
      Object.defineProperty(globalThis,'navigator',{
        value:restrictedNavigator,
        configurable:false,
        writable:false
      });
    } catch (_) {}
    try {
      var serviceWorkerContainer=nativeNavigator.serviceWorker;
      var serviceWorkerPrototype=Object.getPrototypeOf(serviceWorkerContainer);
      Object.defineProperty(serviceWorkerPrototype,'register',{
        value:function(){return Promise.reject(new TypeError('Network access is disabled'))},
        configurable:false,
        writable:false
      });
    } catch (_) {}
    try {
      Object.defineProperty(navigator,'serviceWorker',{
        value:undefined,
        configurable:false,
        writable:false
      });
    } catch (_) {}
    try {
      Object.defineProperty(Navigator.prototype,'serviceWorker',{
        get:function(){return undefined},
        configurable:false
      });
    } catch (_) {}
    addEventListener('click',function(event){
      var target=event.target;
      var anchor=target instanceof Element?target.closest('a[href]'):null;
      if(!anchor) return;
      if(anchor.hasAttribute('download')||/^(?:https?|wss?):${'$'}/.test(anchor.protocol)){
        event.preventDefault();
      }
    },true);
    })();
""".trimIndent()

internal fun installMobileWebNetworkApiBlocker(
  webView: WebView,
  allowedOrigin: String
): ScriptHandler {
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
    throw IllegalStateException("mobile_web_network_api_blocker_unavailable")
  }
  return WebViewCompat.addDocumentStartJavaScript(
    webView,
    MOBILE_WEB_NETWORK_API_BLOCKER,
    setOf(allowedOrigin)
  )
}
