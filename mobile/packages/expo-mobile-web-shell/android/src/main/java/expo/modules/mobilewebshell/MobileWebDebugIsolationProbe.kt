package expo.modules.mobilewebshell

import android.content.pm.ApplicationInfo
import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.AppContext
import java.util.UUID

private const val NETWORK_PROBE_PORT_EXTRA = "ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_PORT"
private const val NETWORK_PROBE_TOKEN_EXTRA = "ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_TOKEN"

internal fun installMobileWebDebugIsolationProbe(
  webView: WebView,
  appContext: AppContext,
  allowedOrigin: String
): ScriptHandler? {
  val applicationFlags = webView.context.applicationInfo.flags
  val isDebuggable = applicationFlags and ApplicationInfo.FLAG_DEBUGGABLE != 0
  WebView.setWebContentsDebuggingEnabled(isMobileWebInspectionEnabled(applicationFlags))
  // The loopback security probe stays DEBUG-only; an inspectable release gets DevTools without it.
  if (!BuildConfig.DEBUG || !isDebuggable) return null
  val intent = appContext.currentActivity?.intent ?: return null
  val script = createMobileWebDebugIsolationProbeScript(
    intent.getStringExtra(NETWORK_PROBE_PORT_EXTRA),
    intent.getStringExtra(NETWORK_PROBE_TOKEN_EXTRA)
  ) ?: return null
  if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
    return WebViewCompat.addDocumentStartJavaScript(
      webView,
      script,
      setOf(allowedOrigin)
    )
  } else {
    throw IllegalStateException("mobile_web_debug_isolation_probe_unavailable")
  }
}

internal fun createMobileWebDebugIsolationProbeScript(
  portValue: String?,
  tokenValue: String?
): String? {
  val port = portValue?.toIntOrNull()?.takeIf { it in 1..65_535 } ?: return null
  val token = tokenValue?.takeIf(::isUuid) ?: return null
  val quotedToken = "\"$token\""
  return """
    (function(){
      globalThis.__orcaRunSecurityProbe=function(){
        if(globalThis.__orcaDebugSecurityProbeStarted===$quotedToken) return;
        if(globalThis.__orcaMobileWebShellListening!==true) return;
        globalThis.__orcaDebugSecurityProbeStarted=$quotedToken;
      var probeBase='http://127.0.0.1:$port';
      var originalOrigin=String(location.origin);
      var originalSession=String(location.hash);
      var popupBlocked=false;
      var serviceWorkerBlocked=typeof navigator.serviceWorker==='undefined';
      var executableProbeFinished=false;
      var completed=0;
      var frame=null;
      var download=null;
      var complete=function(){
        completed+=1;
        if(completed===4) globalThis.__orcaDebugNetworkProbeCompletion=$quotedToken;
      };
      try {
        fetch(probeBase+'/network-probe').catch(function(){});
      } catch (_) {} finally { complete(); }
      try {
        var request=new XMLHttpRequest();
        request.open('GET',probeBase+'/network-probe');
        request.send();
      } catch (_) {} finally { complete(); }
      try {
        var socket=new WebSocket('ws://127.0.0.1:$port/socket-probe');
        socket.onerror=function(){};
      } catch (_) {} finally { complete(); }
      try {
        var image=new Image();
        image.onerror=function(){};
        image.src=probeBase+'/network-probe';
        document.documentElement.appendChild(image);
      } catch (_) {} finally { complete(); }
      try {
        popupBlocked=window.open(probeBase+'/popup-probe','_blank')===null;
      } catch (_) { popupBlocked=true; }
      try {
        frame=document.createElement('iframe');
        frame.hidden=true;
        frame.src=probeBase+'/redirect-probe';
        document.documentElement.appendChild(frame);
      } catch (_) {}
      try {
        download=document.createElement('a');
        download.hidden=true;
        download.download='orca-security-probe.txt';
        download.href=probeBase+'/download-probe';
        document.documentElement.appendChild(download);
        download.click();
      } catch (_) {}
      try {
        if(!serviceWorkerBlocked){
          navigator.serviceWorker.register(probeBase+'/worker-probe').then(
            function(){serviceWorkerBlocked=false;},
            function(){serviceWorkerBlocked=true;}
          );
        }
      } catch (_) { serviceWorkerBlocked=true; }
      try { location.assign('orca-security-probe://blocked'); } catch (_) {}
      var declaredScriptPath=function(script){
        var source=script.getAttribute('src');
        if(!source) return null;
        var relative=source.match(/^(?:\.\/|\/)?assets\/([a-f0-9]{64}\.js)${'$'}/);
        if(relative) return '/assets/'+relative[1];
        try {
          var url=new URL(source,location.origin+'/');
          return url.origin===location.origin&&
            /^\/assets\/[a-f0-9]{64}\.js${'$'}/.test(url.pathname)?url.pathname:null;
        } catch (_) { return null; }
      };
      var finishExecutableProbe=function(undeclaredScriptBlocked){
        if(executableProbeFinished) return;
        executableProbeFinished=true;
        var scripts=Array.from(document.scripts).filter(function(script){
          return script.src&&new URL(script.src).origin===location.origin;
        });
        var activeScript=scripts.find(function(script){
          return declaredScriptPath(script)!==null;
        });
        globalThis.__orcaDebugExecutableProbeCompletion=JSON.stringify({
          token:$quotedToken,
          activeDeclaredScriptLoaded:Boolean(
            activeScript&&globalThis.__orcaMobileWebShellListening===true
          ),
          undeclaredScriptBlocked:undeclaredScriptBlocked,
          documentRetained:String(location.origin)===originalOrigin&&
            String(location.hash)===originalSession,
          bridgeListening:globalThis.__orcaMobileWebShellListening===true,
          scriptPaths:scripts.map(function(script){return new URL(script.src).pathname;})
        });
      };
      try {
        var activeScript=Array.from(document.scripts).find(function(script){
          return declaredScriptPath(script)!==null;
        });
        if(!activeScript){
          finishExecutableProbe(false);
        }else{
          var undeclaredUrl=new URL(declaredScriptPath(activeScript),location.origin);
          var name=undeclaredUrl.pathname.split('/').pop();
          undeclaredUrl.pathname='/assets/'+(name[0]==='0'?'1':'0')+name.slice(1);
          var undeclaredScript=document.createElement('script');
          undeclaredScript.src=undeclaredUrl.href;
          undeclaredScript.onload=function(){finishExecutableProbe(false);};
          undeclaredScript.onerror=function(){finishExecutableProbe(true);};
          document.documentElement.appendChild(undeclaredScript);
          setTimeout(function(){finishExecutableProbe(false);},250);
        }
      } catch (_) { finishExecutableProbe(false); }
      setTimeout(function(){
        globalThis.__orcaDebugNavigationProbeCompletion=JSON.stringify({
          token:$quotedToken,
          documentRetained:String(location.origin)===originalOrigin&&
            String(location.hash)===originalSession,
          popupBlocked:popupBlocked,
          serviceWorkerBlocked:serviceWorkerBlocked,
          redirectFrameAttempted:true,
          downloadAttempted:true,
          externalSchemeAttempted:true
        });
        if(frame) frame.remove();
        if(download) download.remove();
      },250);
      };
    })();
  """.trimIndent()
}

private fun isUuid(value: String): Boolean {
  val parsed = runCatching { UUID.fromString(value) }.getOrNull() ?: return false
  return parsed.toString().equals(value, ignoreCase = true)
}
