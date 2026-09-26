package expo.modules.orcamobilewebshell

import android.app.Activity
import android.os.*
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import java.util.concurrent.Executors
import org.json.JSONObject

/** Exactly one WebView in this process; no React host or OTA document. */
@androidx.annotation.RequiresApi(28)
class BrowserGuestActivity : Activity() {
  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()
  private var view: WebView? = null
  private var engine: EngineCdp? = null
  private var owner: Messenger? = null
  private var generation = ""
  private var attached = false
  private var foreground = false
  private var busy = false
  private var ending = false
  private val ownerDeath = IBinder.DeathRecipient { main.post { shutdown() } }
  private val endpoint = Messenger(Handler(Looper.getMainLooper()) { message ->
    if (message.data.getString("generation") != generation || ending) return@Handler true
    val id = message.arg1
    if (message.what == 3 && BuildConfig.BROWSER_FIXTURE) {
      Process.killProcess(Process.myPid())
    } else if (message.what == 2) {
      reply(id, "{}")
      shutdown()
    } else if (!foreground) {
      reply(id, error = "guest_not_foreground")
    } else if (busy || !attached) {
      reply(id, error = "guest_busy_or_unavailable")
    } else {
      busy = true
      val raw = message.data.getString("request") ?: ""
      worker.execute {
        try {
          require(raw.length <= 65536) { "command_too_large" }
          val result = execute(JSONObject(raw)).toString()
          require(result.length <= 240000) { "result_too_large" }
          main.post { busy = false; if (foreground) reply(id, result) else reply(id, error = "guest_not_foreground") }
        } catch (error: Exception) {
          main.post { busy = false; reply(id, error = error.message ?: "command_failed") }
        }
      }
    }
    true
  })

  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    try {
      check(BuildConfig.BROWSER_FIXTURE) { "native_browser_admission_disabled" }
      check(android.app.Application.getProcessName() == "$packageName:orca_browser")
      @Suppress("DEPRECATION")
      val caller = intent.getParcelableExtra<Messenger>("owner") ?: error("owner_required")
      owner = caller
      caller.binder.linkToDeath(ownerDeath, 0)
      generation = intent.getStringExtra("generation") ?: error("generation_required")
      reply(-1, endpoint = endpoint)
      main.postDelayed({ if (engine == null) shutdown() }, 14000)
      val route = BrowserGuestRoute.parse(intent.getStringExtra("route") ?: "")
      WebView.setDataDirectorySuffix(route.profile)
      check(WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) { "proxy_unavailable" }
      WebView.setWebContentsDebuggingEnabled(true)
      val marker = "about:blank#$generation"
      val guest = WebView(this)
      view = guest
      guest.settings.javaScriptEnabled = true
      guest.settings.domStorageEnabled = true
      guest.settings.allowFileAccess = false
      guest.settings.allowContentAccess = false
      guest.webViewClient = object : WebViewClient() {
        override fun onPageFinished(webView: WebView, url: String) {
          if (url != marker || attached || ending) return
          attached = true
          worker.execute {
            try {
              val cdp = EngineCdp()
              engine = cdp
              val targets = cdp.discover()
              check(targets.length() == 1) { "unexpected_guest_targets" }
              val target = targets.getJSONObject(0)
              check(target.getString("url") == marker && target.getString("type") == "page") { "owned_target_missing" }
              cdp.attach(target.getString("webSocketDebuggerUrl"))
              main.post { reply(0, JSONObject().put("generation", generation).put("pid", Process.myPid()).put("profile", route.profile).toString(), endpoint) }
            } catch (error: Exception) {
              main.post { reply(0, error = error.message ?: "attach_failed"); shutdown() }
            }
          }
        }
      }
      setContentView(guest)
      val proxy = ProxyConfig.Builder().addProxyRule(route.proxy).addBypassRule("<-loopback>").build()
      ProxyController.getInstance().setProxyOverride(proxy, main::post) { guest.loadUrl(marker) }
    } catch (error: Exception) {
      reply(0, error = error.message ?: "open_failed")
      shutdown()
    }
  }

  private fun execute(request: JSONObject): JSONObject {
    val cdp = engine ?: error("guest_unavailable")
    val params = request.optJSONObject("params") ?: JSONObject()
    return when (request.getString("operation")) {
      "navigate" -> cdp.command("Page.navigate", JSONObject().put("url", BrowserGuestRoute.navigationUrl(params.getString("url"))))
      "evaluate" -> {
        val result = cdp.command("Runtime.evaluate", JSONObject().put("expression", params.getString("expression")).put("returnByValue", true))
        check(!result.has("exceptionDetails")) { "evaluation_exception: ${result.get("exceptionDetails")}" }
        result
      }
      "accessibility" -> cdp.command("Accessibility.getFullAXTree")
      "screenshot" -> cdp.command("Page.captureScreenshot", JSONObject().put("format", "png"))
      "insertText" -> cdp.command("Input.insertText", JSONObject().put("text", params.getString("text")))
      "click" -> {
        val x = params.getDouble("x")
        val y = params.getDouble("y")
        require(x.isFinite() && y.isFinite() && x >= 0 && y >= 0) { "invalid_coordinates" }
        val point = JSONObject().put("x", x).put("y", y).put("button", "left").put("clickCount", 1)
        cdp.command("Input.dispatchMouseEvent", point.put("type", "mousePressed"))
        cdp.command("Input.dispatchMouseEvent", point.put("type", "mouseReleased"))
      }
      else -> error("unsupported_operation")
    }
  }

  private fun reply(id: Int, result: String = "", endpoint: Messenger? = null, error: String? = null) {
    if (ending) return
    try {
      owner?.send(Message.obtain().apply {
        arg1 = id
        replyTo = endpoint
        data = Bundle().apply { putString("generation", generation); putString("result", result); putString("error", error) }
      })
    } catch (_: RemoteException) { shutdown() }
  }

  private fun shutdown() {
    if (ending) return
    ending = true
    owner?.binder?.unlinkToDeath(ownerDeath, 0)
    engine?.close()
    view?.destroy()
    view = null
    worker.shutdownNow()
    WebView.setWebContentsDebuggingEnabled(false)
    finish()
    // WebView's process-wide profile and proxy cannot be safely reassigned in this process.
    Process.killProcess(Process.myPid())
  }

  private fun publishForeground(value: Boolean) {
    foreground = value
    try {
      owner?.send(Message.obtain().apply {
        arg1 = -2
        data = Bundle().apply { putString("generation", generation); putBoolean("foreground", value) }
      })
    } catch (_: RemoteException) { shutdown() }
  }

  override fun onResume() { super.onResume(); publishForeground(true) }
  override fun onPause() { publishForeground(false); super.onPause() }

  override fun onDestroy() { super.onDestroy(); shutdown() }
}
