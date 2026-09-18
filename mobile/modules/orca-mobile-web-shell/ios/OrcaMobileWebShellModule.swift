import ExpoModulesCore

public class OrcaMobileWebShellModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OrcaMobileWebShell")

    View(OrcaMobileWebShellView.self) {
      Events("onLoadState")

      Prop("generationDirectory") { (view: OrcaMobileWebShellView, value: String) in
        view.setGenerationDirectory(value)
      }

      Prop("sessionId") { (view: OrcaMobileWebShellView, value: String) in
        view.setSessionId(value)
      }

      OnViewDidUpdateProps { (view: OrcaMobileWebShellView) in
        view.propsDidUpdate()
      }
    }
  }
}
