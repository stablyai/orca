package expo.modules.orcamobilewebshell

import android.content.ComponentCallbacks2
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OrcaMobileWebShellModule : Module() {
  // A spare is the first thing to give back: nothing is shown by it.
  private val memoryCallbacks = object : ComponentCallbacks2 {
    override fun onTrimMemory(level: Int) {
      if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) MobileWebShellSparePool.discardAll()
    }

    override fun onConfigurationChanged(newConfig: Configuration) = Unit

    @Deprecated("Deprecated in Java")
    override fun onLowMemory() = MobileWebShellSparePool.discardAll()
  }

  override fun definition() = ModuleDefinition {
    Name("OrcaMobileWebShell")

    OnCreate {
      appContext.reactContext?.applicationContext?.registerComponentCallbacks(memoryCallbacks)
    }

    OnDestroy {
      appContext.reactContext?.applicationContext?.unregisterComponentCallbacks(memoryCallbacks)
      // OnDestroy can run off the main thread, and the pool's WebViews must not.
      Handler(Looper.getMainLooper()).post { MobileWebShellSparePool.discardAll() }
    }

    OnActivityEntersBackground {
      MobileWebShellSparePool.discardAll()
    }

    OnActivityDestroys {
      MobileWebShellSparePool.discardAll()
    }

    AsyncFunction("prepareSpare") { hostKey: String, directory: String, sessionId: String ->
      val activity = appContext.currentActivity ?: return@AsyncFunction
      MobileWebShellSparePool.prepare(activity, hostKey, directory, sessionId)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("takeSpare") { hostKey: String, directory: String ->
      MobileWebShellSparePool.take(hostKey, directory)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("discardSpares") { hostKey: String? ->
      MobileWebShellSparePool.discard(hostKey)
    }.runOnQueue(Queues.MAIN)

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

      AsyncFunction("replayPageReady") { view: OrcaMobileWebShellView ->
        view.replayPageReady()
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
