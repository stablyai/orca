package expo.modules.orcamobilewebshell

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OrcaMobileWebShellModule : Module() {
  private val browser = BrowserGuestOwner()
  override fun definition() = ModuleDefinition {
    Name("OrcaMobileWebShell")

    AsyncFunction("openBrowserFixture") { route: String, promise: expo.modules.kotlin.Promise ->
      val activity = appContext.currentActivity ?: throw IllegalStateException("activity_required")
      val reactContext = appContext.reactContext
      check(reactContext is com.facebook.react.bridge.ReactContext) { "react_context_required" }
      browser.open(activity, route, reactContext).whenComplete { value, error ->
        if (error != null) promise.reject("native_browser", error.message, error) else promise.resolve(value)
      }
    }
    AsyncFunction("browserCommand") { generation: String, request: String, promise: expo.modules.kotlin.Promise ->
      browser.command(generation, request).whenComplete { value, error ->
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
      browser.waitForTaskStop(generation, token).whenComplete { value, error ->
        if (error != null) promise.reject("native_browser", error.message, error) else promise.resolve(value)
      }
    }
    AsyncFunction("resumeBrowser") { generation: String, promise: expo.modules.kotlin.Promise ->
      val activity = appContext.currentActivity ?: throw IllegalStateException("activity_required")
      browser.resume(activity, generation).whenComplete { value, error ->
        if (error != null) promise.reject("native_browser", error.message, error) else promise.resolve(value)
      }
    }
    OnDestroy { browser.destroy() }

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
