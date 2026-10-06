package dev.orca.routeproof;

import android.app.Activity;
import android.os.Bundle;
import android.os.Process;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;

public abstract class RouteActivity extends Activity {
    protected abstract String route();
    private static boolean initialized;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (!initialized) {
            WebView.setDataDirectorySuffix("route_" + route());
            initialized = true;
        }
        Log.i("RouteProof", "create route=" + route() + " pid=" + Process.myPid()
            + " provider=" + WebView.getCurrentWebViewPackage().versionName);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            throw new IllegalStateException("PROXY_OVERRIDE unavailable");
        }
        WebView view = new WebView(this);
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        view.setWebViewClient(new WebViewClient());
        view.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                Log.i("RouteProof", route() + " " + message.message());
                CookieManager.getInstance().flush();
                return true;
            }
        });
        setContentView(view);
        int port = getIntent().getIntExtra("proxyPort", 0);
        if (port <= 0) throw new IllegalArgumentException("proxyPort required");
        ProxyConfig config = new ProxyConfig.Builder()
            .addProxyRule("socks://127.0.0.1:" + port).removeImplicitRules().build();
        ProxyController.getInstance().setProxyOverride(config, this::runOnUiThread,
            () -> view.loadUrl("http://localhost:5173/"));
    }

    @Override protected void onResume() {
        super.onResume();
        Log.i("RouteProof", "resume route=" + route() + " pid=" + Process.myPid());
    }

    @Override protected void onStop() {
        super.onStop();
        Log.i("RouteProof", "stop route=" + route() + " pid=" + Process.myPid());
    }
}
