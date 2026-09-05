package expo.modules.hardwarekeyboard

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoHardwareKeyboardModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoHardwareKeyboard")

    View(HardwareKeyboardCaptureView::class) {
      Events("onHardwareKey")
      Prop("mode") { view: HardwareKeyboardCaptureView, mode: String ->
        view.captureMode = mode
      }

      Prop("enabled") { view: HardwareKeyboardCaptureView, enabled: Boolean ->
        view.captureEnabled = enabled
      }
    }
  }
}
