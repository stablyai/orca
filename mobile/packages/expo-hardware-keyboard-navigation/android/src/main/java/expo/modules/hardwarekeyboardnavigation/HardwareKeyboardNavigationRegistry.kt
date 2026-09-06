package expo.modules.hardwarekeyboardnavigation

import android.view.KeyEvent
import android.view.Window
import android.widget.TextView
import android.view.inputmethod.BaseInputConnection
import java.lang.ref.WeakReference

data class HardwareKeyboardCommand(
  val actionId: String,
  val key: String,
  val control: Boolean,
  val meta: Boolean,
  val alt: Boolean,
  val shift: Boolean
)

object HardwareKeyboardNavigationRegistry {
  @Volatile
  private var commands: List<HardwareKeyboardCommand> = emptyList()
  private val observers = mutableSetOf<WeakReference<(HardwareKeyboardCommand) -> Unit>>()
  private val capturedKeys = mutableSetOf<Pair<Int, Int>>()

  fun setCommands(next: List<HardwareKeyboardCommand>) {
    commands = next
  }

  @Synchronized
  fun addObserver(observer: (HardwareKeyboardCommand) -> Unit): WeakReference<(HardwareKeyboardCommand) -> Unit> {
    val reference = WeakReference(observer)
    observers.add(reference)
    return reference
  }

  @Synchronized
  fun removeObserver(reference: WeakReference<(HardwareKeyboardCommand) -> Unit>?) {
    observers.remove(reference)
    observers.removeAll { it.get() == null }
  }

  fun clearCapturedKeys() {
    capturedKeys.clear()
  }

  fun dispatch(event: KeyEvent, window: Window): Boolean {
    val text = (window.currentFocus as? TextView)?.editableText
    val composing = text != null && BaseInputConnection.getComposingSpanStart(text) >= 0
    return dispatch(event, canStartCapture = !composing)
  }

  fun dispatch(event: KeyEvent, canStartCapture: Boolean = true): Boolean {
    val identity = event.deviceId to event.keyCode
    if (event.action == KeyEvent.ACTION_UP) {
      return capturedKeys.remove(identity)
    }
    if (event.action != KeyEvent.ACTION_DOWN) {
      return false
    }
    if (event.repeatCount > 0) {
      return identity in capturedKeys
    }
    // A fresh down supersedes an up lost during device/window changes.
    capturedKeys.remove(identity)
    if (!canStartCapture) {
      return false
    }
    val key = keyToken(event.keyCode) ?: return false
    val command = commands.firstOrNull {
      it.key == key &&
        it.control == event.isCtrlPressed &&
        it.meta == event.isMetaPressed &&
        it.alt == event.isAltPressed &&
        it.shift == event.isShiftPressed
    } ?: return false
    val currentObservers = synchronized(this) {
      observers.mapNotNull { it.get() }
    }
    if (currentObservers.isEmpty()) {
      return false
    }
    capturedKeys.add(identity)
    currentObservers.forEach { it(command) }
    return true
  }

  private fun keyToken(keyCode: Int): String? = when (keyCode) {
    in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z ->
      ('A'.code + keyCode - KeyEvent.KEYCODE_A).toChar().toString()
    in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 ->
      ('0'.code + keyCode - KeyEvent.KEYCODE_0).toChar().toString()
    KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
    KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
    KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
    KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
    KeyEvent.KEYCODE_LEFT_BRACKET -> "BracketLeft"
    KeyEvent.KEYCODE_RIGHT_BRACKET -> "BracketRight"
    KeyEvent.KEYCODE_PAGE_UP -> "PageUp"
    KeyEvent.KEYCODE_PAGE_DOWN -> "PageDown"
    KeyEvent.KEYCODE_TAB -> "Tab"
    else -> null
  }
}
