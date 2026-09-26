package expo.modules.orcamobilewebshell

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OrcaMobileWebShellModule : Module() {
  private val browser = BrowserGuestOwner.process
  private val browserRuntime = BrowserGuestReactSession()
  @Volatile private var destroyed = false
  private val moduleId = java.util.UUID.randomUUID().toString()

  private fun keepRuntime(generation: String): java.util.concurrent.CompletableFuture<String> {
    check(!destroyed) { "react_module_destroyed" }
    val context = appContext.reactContext
    check(context is com.facebook.react.bridge.ReactContext) { "react_context_required" }
    return browserRuntime.start(context, generation)
  }
  override fun definition() = ModuleDefinition {
    Name("OrcaMobileWebShell")

    AsyncFunction("browserFixtureState") {
      check(BuildConfig.BROWSER_FIXTURE) { "native_browser_admission_disabled" }
      org.json.JSONObject().put("moduleId", moduleId)
        .put("shellFocused", appContext.currentActivity?.hasWindowFocus() == true)
        .put("activity", appContext.currentActivity?.javaClass?.simpleName).toString()
    }
    AsyncFunction("openBrowserFixture") { route: String, promise: expo.modules.kotlin.Promise ->
      val activity = appContext.currentActivity ?: throw IllegalStateException("activity_required")
      browser.open(activity, route).thenCompose { value ->
        keepRuntime(org.json.JSONObject(value).getString("generation")).thenApply { value }
      }.whenComplete { value, error ->
        if (error != null) promise.reject("native_browser", error.message, error) else promise.resolve(value)
      }
    }
    AsyncFunction("browserCommand") { generation: String, request: String, promise: expo.modules.kotlin.Promise ->
      keepRuntime(generation).thenCompose { browser.command(generation, request) }.whenComplete { value, error ->
        if (error != null) promise.reject("native_browser", error.message, error) else promise.resolve(value)
      }
    }
    AsyncFunction("closeBrowser") { generation: String, promise: expo.modules.kotlin.Promise ->
      browser.close(generation).whenComplete { value, error ->
        if (error != null) promise.reject("native_browser", error.message, error) else promise.resolve(value)
      }
    }
    AsyncFunction("terminateBrowserFixture") { generation: String, promise: expo.modules.kotlin.Promise ->
      browser.terminateFixture(generation).whenComplete { value, error ->
        if (error != null) promise.reject("native_browser", error.message, error) else promise.resolve(value)
      }
    }
    AsyncFunction("waitBrowserTaskStopped") { generation: String, token: String, promise: expo.modules.kotlin.Promise ->
      browserRuntime.waitForStop(generation, token).whenComplete { value, error ->
        if (error != null) promise.reject("native_browser", error.message, error) else promise.resolve(value)
      }
    }
    AsyncFunction("resumeBrowser") { generation: String, promise: expo.modules.kotlin.Promise ->
      val activity = appContext.currentActivity ?: throw IllegalStateException("activity_required")
      keepRuntime(generation).thenCompose { browser.resume(activity, generation) }.whenComplete { value, error ->
        if (error != null) promise.reject("native_browser", error.message, error) else promise.resolve(value)
      }
    }
    OnDestroy {
      destroyed = true
      browserRuntime.destroy()
      if (BuildConfig.BROWSER_FIXTURE) android.util.Log.i("OrcaBrowserFixture", "module_destroyed $moduleId")
    }

    View(OrcaMobileWebShellView::class) {
      Events("onLoadState", "onBridgeMessage", "onExternalNavigation")

      Prop("generationDirectory") { view: OrcaMobileWebShellView, value: String ->
        view.setGenerationDirectory(value)
      }

      Prop("sessionId") { view: OrcaMobileWebShellView, value: String ->
        view.setSessionId(value)
      }

      Prop("bridgeEnabled") { view: OrcaMobileWebShellView, value: Boolean ->
        view.setBridgeEnabled(value)
      }

      AsyncFunction("postBridgeMessage") { view: OrcaMobileWebShellView, json: String ->
        view.postBridgeMessage(json)
      }

      OnViewDidUpdateProps { view: OrcaMobileWebShellView ->
        view.propsDidUpdate()
      }

      OnViewDestroys { view: OrcaMobileWebShellView ->
        view.destroyWebView()
      }
    }
  }
}
