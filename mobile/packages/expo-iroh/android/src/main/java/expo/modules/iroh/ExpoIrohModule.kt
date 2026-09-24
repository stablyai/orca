package expo.modules.iroh

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val NOT_IMPLEMENTED = "iroh_android_not_implemented"

class IrohAndroidNotImplementedException :
  CodedException(NOT_IMPLEMENTED, "Iroh is not implemented on Android yet", null)

class ExpoIrohModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoIroh")

    Events("onMessage", "onPathChanged", "onClosed")

    AsyncFunction("irohStart") {
      throw IrohAndroidNotImplementedException()
    }

    AsyncFunction("irohConnect") { _: String, _: String?, _: List<String>? ->
      throw IrohAndroidNotImplementedException()
    }

    AsyncFunction("irohSend") { _: String, _: String ->
      throw IrohAndroidNotImplementedException()
    }

    AsyncFunction("irohPathInfo") { _: String ->
      throw IrohAndroidNotImplementedException()
    }

    AsyncFunction("irohClose") { _: String ->
      throw IrohAndroidNotImplementedException()
    }

    AsyncFunction("irohStop") {
      throw IrohAndroidNotImplementedException()
    }
  }
}
