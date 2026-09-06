package expo.modules.hardwarekeyboard

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoHardwareKeyboardModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoHardwareKeyboard")
    Constants("supportsNativeFieldBoundaries" to true, "supportsPrimaryModifierSubmit" to true,
      "supportsHardwarePaste" to true)

    View(HardwareKeyboardCaptureView::class) {
      Events("onHardwareKey")
      Prop("hardwarePaste") { view: HardwareKeyboardCaptureView, enabled: Boolean ->
        view.hardwarePaste = enabled
      }
      Prop("submitWithPrimaryModifier") { view: HardwareKeyboardCaptureView, enabled: Boolean ->
        view.submitWithPrimaryModifier = enabled
      }
      Prop("nativeFieldBoundaries") { view: HardwareKeyboardCaptureView, enabled: Boolean ->
        view.nativeFieldBoundaries = enabled
      }
      Prop("mode") { view: HardwareKeyboardCaptureView, mode: String ->
        view.captureMode = mode
      }

      Prop("enabled") { view: HardwareKeyboardCaptureView, enabled: Boolean ->
        view.captureEnabled = enabled
      }
    }
  }
}
