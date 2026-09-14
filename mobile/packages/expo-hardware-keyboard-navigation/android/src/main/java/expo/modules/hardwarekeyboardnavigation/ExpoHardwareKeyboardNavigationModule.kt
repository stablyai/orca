package expo.modules.hardwarekeyboardnavigation

import android.content.Context
import android.hardware.input.InputManager
import android.view.InputDevice
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

class ExpoHardwareKeyboardNavigationModule : Module() {
  private var observer: ((HardwareKeyboardCommand) -> Unit)? = null
  private var observerReference: WeakReference<(HardwareKeyboardCommand) -> Unit>? = null

  override fun definition() = ModuleDefinition {
    Name("ExpoHardwareKeyboardNavigation")
    Events("onHardwareKeyboardCommand")

    Function("setCommands") { records: List<Map<String, Any?>> ->
      HardwareKeyboardNavigationRegistry.setCommands(records.mapNotNull(::decodeCommand))
    }

    Function("isHardwareKeyboardConnected") {
      val context = appContext.reactContext ?: return@Function false
      val inputManager = context.getSystemService(Context.INPUT_SERVICE) as InputManager
      inputManager.inputDeviceIds.any { deviceId ->
        val device = inputManager.getInputDevice(deviceId)
        device != null && !device.isVirtual && device.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC
      }
    }

    OnStartObserving("onHardwareKeyboardCommand") {
      val observer: (HardwareKeyboardCommand) -> Unit = { command ->
        sendEvent(
          "onHardwareKeyboardCommand",
          mapOf("actionId" to command.actionId, "key" to command.key)
        )
      }
      this@ExpoHardwareKeyboardNavigationModule.observer = observer
      observerReference = HardwareKeyboardNavigationRegistry.addObserver(observer)
    }

    OnStopObserving("onHardwareKeyboardCommand") {
      HardwareKeyboardNavigationRegistry.removeObserver(observerReference)
      observerReference = null
      observer = null
    }
  }

  private fun decodeCommand(record: Map<String, Any?>): HardwareKeyboardCommand? {
    val actionId = record["actionId"] as? String ?: return null
    val key = record["key"] as? String ?: return null
    return HardwareKeyboardCommand(
      actionId = actionId,
      key = key,
      control = record["control"] as? Boolean ?: false,
      meta = record["meta"] as? Boolean ?: false,
      alt = record["alt"] as? Boolean ?: false,
      shift = record["shift"] as? Boolean ?: false
    )
  }
}
