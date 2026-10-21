import ExpoModulesCore

public class OrcaMobileWebShellModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OrcaMobileWebShell")

    Function("clearRetainedSlot") {
      if Thread.isMainThread {
        OrcaMobileWebShellView.clearRetainedSlot()
      } else {
        DispatchQueue.main.async {
          OrcaMobileWebShellView.clearRetainedSlot()
        }
      }
    }

    View(OrcaMobileWebShellView.self) {
      Events("onLoadState", "onBridgeMessage", "onExternalNavigation")

      Prop("generationDirectory") { (view: OrcaMobileWebShellView, value: String) in
        view.setGenerationDirectory(value)
      }

      Prop("sessionId") { (view: OrcaMobileWebShellView, value: String) in
        view.setSessionId(value)
      }

      Prop("bridgeEnabled") { (view: OrcaMobileWebShellView, value: Bool) in
        view.setBridgeEnabled(value)
      }

      Prop("retainsSlot") { (view: OrcaMobileWebShellView, value: Bool) in
        view.setRetainsSlot(value)
      }

      AsyncFunction("postBridgeMessage") {
        (view: OrcaMobileWebShellView, json: String, promise: Promise) in
        try view.postBridgeMessage(json, promise: promise)
      }

      OnViewDidUpdateProps { (view: OrcaMobileWebShellView) in
        view.propsDidUpdate()
      }

      OnViewDestroys { (view: OrcaMobileWebShellView) in
        view.destroyWebView()
      }
    }
  }
}
