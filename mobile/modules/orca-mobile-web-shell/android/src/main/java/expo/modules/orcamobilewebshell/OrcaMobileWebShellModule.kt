package expo.modules.orcamobilewebshell

import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OrcaMobileWebShellModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OrcaMobileWebShell")

    Function("clearRetainedSlot") {
      if (Looper.myLooper() == Looper.getMainLooper()) {
        OrcaMobileWebShellView.clearRetainedSlot()
      } else {
        Handler(Looper.getMainLooper()).post {
          OrcaMobileWebShellView.clearRetainedSlot()
        }
      }
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

      Prop("retainsSlot") { view: OrcaMobileWebShellView, value: Boolean ->
        view.setRetainsSlot(value)
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
