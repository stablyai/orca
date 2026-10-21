package expo.modules.orcaterminalkeycapture

import android.content.Context
import android.view.KeyEvent
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * Takes terminal keys from the focused field inside it before the field sees them.
 *
 * React Native's Android TextInput reports only Backspace, Enter and digits to `onKeyPress`; every
 * other key event reaches `TextView`, which drops it or runs an editing shortcut (Ctrl+A selects,
 * Ctrl+V pastes). A parent's `dispatchKeyEvent` runs before the focused child's, for hardware keys
 * and for keys an IME sends with `InputConnection.sendKeyEvent` alike.
 */
internal class OrcaTerminalKeyCaptureView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {
  private val onTerminalKey by EventDispatcher<Map<String, Any>>()

  // Why: the matching key-up must not reach the field either, even if a modifier was released first.
  private val capturedKeyCodes = mutableSetOf<Int>()

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    when (event.action) {
      KeyEvent.ACTION_DOWN -> {
        val chord = TerminalKeyChord.fromKeyDown(event.keyCode, event.metaState, event.getUnicodeChar(0))
        if (chord != null) {
          capturedKeyCodes.add(event.keyCode)
          onTerminalKey(chord.toEventPayload())
          return true
        }
      }
      KeyEvent.ACTION_UP -> if (capturedKeyCodes.remove(event.keyCode)) {
        return true
      }
    }
    return super.dispatchKeyEvent(event)
  }
}
