package expo.modules.hardwarekeyboardnavigation

import android.view.KeyEvent
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

  fun dispatch(event: KeyEvent): Boolean {
    if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount > 0) {
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
