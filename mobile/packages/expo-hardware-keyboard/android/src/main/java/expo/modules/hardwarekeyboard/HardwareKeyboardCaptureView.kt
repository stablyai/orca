package expo.modules.hardwarekeyboard

import android.content.Context
import android.view.KeyEvent
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * ViewGroup host for the RN TextInput. Intercepts terminal special keys and
 * Ctrl-modified printable keys on ACTION_DOWN; leaves plain/Shift printable,
 * Enter (onSubmitEditing), Ctrl+Space (IME switch), and Meta/system shortcuts
 * to TextInput / the system.
 */
class HardwareKeyboardCaptureView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {

  private val onHardwareKey by EventDispatcher()

  var captureEnabled: Boolean = true

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (!captureEnabled || event.action != KeyEvent.ACTION_DOWN) {
      return super.dispatchKeyEvent(event)
    }

    val meta = event.metaState
    val hasMeta = (meta and KeyEvent.META_META_ON) != 0
    // Why: Meta stays system-owned so Cmd/Win shortcuts are not stolen.
    if (hasMeta) {
      return super.dispatchKeyEvent(event)
    }

    val ctrl = (meta and KeyEvent.META_CTRL_ON) != 0
    val alt = (meta and KeyEvent.META_ALT_ON) != 0
    val shift = (meta and KeyEvent.META_SHIFT_ON) != 0
    val repeat = event.repeatCount > 0

    // Why: Enter is owned by TextInput onSubmitEditing (same as TS mapper ignore).
    if (
      event.keyCode == KeyEvent.KEYCODE_ENTER ||
      event.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
    ) {
      return super.dispatchKeyEvent(event)
    }

    // Why: Ctrl+Space switches input methods; must not become terminal NUL.
    if (ctrl && event.keyCode == KeyEvent.KEYCODE_SPACE) {
      return super.dispatchKeyEvent(event)
    }

    val key = canonicalKey(event) ?: return super.dispatchKeyEvent(event)
    val isSpecial = isTerminalSpecialKey(key)
    val isAlternateLayoutPrintable =
      key.length == 1 &&
        ((meta and KeyEvent.META_ALT_RIGHT_ON) != 0 || producesAlternateLayoutText(event))
    // Why: AltGr and layout-specific Alt characters belong to TextInput even
    // when a keyboard reports AltGr as synthesized Ctrl+Alt.
    val isCtrlPrintable =
      ctrl && !isAlternateLayoutPrintable && key.length == 1 && key[0] in '!'..'~'

    if (!isSpecial && !isCtrlPrintable) {
      return super.dispatchKeyEvent(event)
    }

    onHardwareKey(
      mapOf(
        "key" to key,
        "modifiers" to mapOf(
          "ctrl" to ctrl,
          "alt" to alt,
          "shift" to shift,
          "meta" to false
        ),
        "repeat" to repeat
      )
    )
    return true
  }

  // Shift and Caps Lock change case but do not indicate alternate-layout text.
  private fun producesAlternateLayoutText(event: KeyEvent): Boolean {
    val altOnly = event.metaState and KeyEvent.META_ALT_MASK
    if (altOnly == 0) {
      return false
    }
    val alternateCharacter = event.getUnicodeChar(altOnly)
    val unmodifiedCharacter = event.getUnicodeChar(0)
    return alternateCharacter != 0 && alternateCharacter != unmodifiedCharacter
  }

  private fun canonicalKey(event: KeyEvent): String? {
    return when (event.keyCode) {
      KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
      KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
      KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
      KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
      KeyEvent.KEYCODE_ESCAPE -> "Escape"
      KeyEvent.KEYCODE_TAB -> "Tab"
      KeyEvent.KEYCODE_DEL -> "Backspace"
      KeyEvent.KEYCODE_FORWARD_DEL -> "Delete"
      KeyEvent.KEYCODE_MOVE_HOME -> "Home"
      KeyEvent.KEYCODE_MOVE_END -> "End"
      KeyEvent.KEYCODE_PAGE_UP -> "PageUp"
      KeyEvent.KEYCODE_PAGE_DOWN -> "PageDown"
      KeyEvent.KEYCODE_F1 -> "F1"
      KeyEvent.KEYCODE_F2 -> "F2"
      KeyEvent.KEYCODE_F3 -> "F3"
      KeyEvent.KEYCODE_F4 -> "F4"
      KeyEvent.KEYCODE_F5 -> "F5"
      KeyEvent.KEYCODE_F6 -> "F6"
      KeyEvent.KEYCODE_F7 -> "F7"
      KeyEvent.KEYCODE_F8 -> "F8"
      KeyEvent.KEYCODE_F9 -> "F9"
      KeyEvent.KEYCODE_F10 -> "F10"
      KeyEvent.KEYCODE_F11 -> "F11"
      KeyEvent.KEYCODE_F12 -> "F12"
      KeyEvent.KEYCODE_SPACE -> " "
      else -> {
        val label = event.displayLabel
        if (label != '\u0000' && !label.isISOControl()) {
          label.lowercaseChar().toString()
        } else {
          null
        }
      }
    }
  }

  private fun isTerminalSpecialKey(key: String): Boolean {
    return key == "ArrowUp" || key == "ArrowDown" || key == "ArrowLeft" || key == "ArrowRight" ||
      key == "Escape" || key == "Tab" || key == "Backspace" || key == "Delete" ||
      key == "Home" || key == "End" || key == "PageUp" || key == "PageDown" ||
      key.startsWith("F")
  }
}
