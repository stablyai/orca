import ExpoModulesCore

public class ExpoHardwareKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoHardwareKeyboard")

    View(HardwareKeyboardCaptureView.self) {
      Events("onHardwareKey")

      Prop("enabled") { (view: HardwareKeyboardCaptureView, enabled: Bool) in
        view.enabled = enabled
      }
    }
  }
}
