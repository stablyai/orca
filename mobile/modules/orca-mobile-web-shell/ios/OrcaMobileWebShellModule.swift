import ExpoModulesCore

public class OrcaMobileWebShellModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OrcaMobileWebShell")

    OnCreate {
      // A second after creation keeps the warm-up off the launch's first frames.
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
        MobileWebShellWarmUp.start()
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

      AsyncFunction("postBridgeMessage") {
        (view: OrcaMobileWebShellView, json: String, promise: Promise) in
        try view.postBridgeMessage(json, promise: promise)
      }

      OnViewDidUpdateProps { (view: OrcaMobileWebShellView) in
        view.propsDidUpdate()
      }
    }
  }
}
