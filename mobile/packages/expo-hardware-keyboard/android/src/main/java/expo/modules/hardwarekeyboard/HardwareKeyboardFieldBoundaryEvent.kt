package expo.modules.hardwarekeyboard

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

internal class HardwareKeyboardFieldBoundaryEvent(
  surfaceId: Int,
  viewId: Int,
  private val eventCount: Int,
  private val hardwareKey: Map<String, Any>
) : Event<HardwareKeyboardFieldBoundaryEvent>(surfaceId, viewId) {
  override fun getEventName(): String = "topChange"

  // A later text change must not coalesce across the control that ended its field.
  override fun canCoalesce(): Boolean = false

  override fun getEventData(): WritableMap = Arguments.createMap().apply {
    putString("text", "")
    putInt("eventCount", eventCount)
    putInt("target", viewTag)
    putMap("hardwareKey", Arguments.makeNativeMap(hardwareKey))
  }
}
