package dev.orca.automationproof;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.os.Process;
import android.util.Log;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.File;
import java.nio.file.Files;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

public final class RouteActivity extends Activity {
    private WebView view;
    private final CompletableFuture<Void> loaded = new CompletableFuture<>();
    private final JSONObject evidence = new JSONObject();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        WebView.setDataDirectorySuffix("automation_route");
        WebView.setWebContentsDebuggingEnabled(false);
        view = new WebView(this);
        view.getSettings().setJavaScriptEnabled(true);
        view.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String url) { loaded.complete(null); }
        });
        setContentView(view);
        view.loadUrl("file:///android_asset/page.html");
        new Thread(this::runProof, "engine-proof").start();
    }

    private void runProof() {
        String name = "webview_devtools_remote_" + Process.myPid();
        try {
            loaded.get(15, TimeUnit.SECONDS);
            evidence.put("pid", Process.myPid()).put("uid", Process.myUid())
                .put("shellPid", getIntent().getIntExtra("shellPid", 0))
                .put("debuggable", (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0)
                .put("webView", WebView.getCurrentWebViewPackage().versionName).put("socket", name);
            try (EngineCdp disabled = new EngineCdp(name)) {
                try { evidence.put("debugDisabledDiscovery", disabled.discover()); }
                catch (Exception expected) { evidence.put("debugDisabledRejected", expected.toString()); }
            }
            if (!"off".equals(getIntent().getStringExtra("mode"))) {
                setDebugging(true);
                try (EngineCdp cdp = new EngineCdp(name)) {
                    JSONArray pages = cdp.discover();
                    evidence.put("discovery", pages);
                    if (pages.length() != 1) throw new IllegalStateException("expected exactly one owned page");
                    cdp.attach(pages.getJSONObject(0).getString("webSocketDebuggerUrl"));
                    EngineJourney.run(cdp, evidence, getExternalFilesDir(null));
                }
                setDebugging(false);
                try (EngineCdp disabled = new EngineCdp(name)) {
                    try { evidence.put("liveDisableDiscovery", disabled.discover()); }
                    catch (Exception expected) { evidence.put("liveDisableRejected", expected.toString()); }
                }
                setDebugging(true);
            }
            evidence.put("completed", true);
        } catch (Exception error) {
            try { evidence.put("failure", Log.getStackTraceString(error)); } catch (Exception ignored) {}
        } finally {
            try {
                File pending = new File(getExternalFilesDir(null), "evidence.pending");
                Files.write(pending.toPath(), evidence.toString(2).getBytes(java.nio.charset.StandardCharsets.UTF_8));
                Files.move(pending.toPath(), new File(getExternalFilesDir(null), "evidence.json").toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                Log.i("AutomationProof", "RESULT " + evidence.optBoolean("completed") + " pid=" + Process.myPid());
            } catch (Exception error) { Log.e("AutomationProof", "evidence write failed", error); }
        }
    }

    private void setDebugging(boolean enabled) throws Exception {
        CompletableFuture<Void> changed = new CompletableFuture<>();
        runOnUiThread(() -> {
            try { WebView.setWebContentsDebuggingEnabled(enabled); changed.complete(null); }
            catch (Exception error) { changed.completeExceptionally(error); }
        });
        changed.get(5, TimeUnit.SECONDS);
    }
}
