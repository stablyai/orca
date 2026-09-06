import ExpoModulesCore

public class ExpoHardwareKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoHardwareKeyboard")
    Constants(["supportsPrimaryModifierSubmit": true])

    View(HardwareKeyboardCaptureView.self) {
      Events("onHardwareKey")
      Prop("submitWithPrimaryModifier") { (view: HardwareKeyboardCaptureView, enabled: Bool) in
        view.submitWithPrimaryModifier = enabled
      }
      Prop("mode") { (view: HardwareKeyboardCaptureView, mode: String) in
        view.captureMode = mode
      }

      Prop("enabled") { (view: HardwareKeyboardCaptureView, enabled: Bool) in
        view.enabled = enabled
      }
    }
  }
}
