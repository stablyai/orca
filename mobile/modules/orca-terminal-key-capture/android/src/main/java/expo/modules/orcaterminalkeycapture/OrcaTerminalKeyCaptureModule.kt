package expo.modules.orcaterminalkeycapture

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OrcaTerminalKeyCaptureModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OrcaTerminalKeyCapture")

    View(OrcaTerminalKeyCaptureView::class) {
      Events("onTerminalKey")
    }
  }
}
