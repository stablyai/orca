package expo.modules.orcaterminalkeycapture

import android.view.KeyCharacterMap
import android.view.KeyEvent

/** A key the terminal owns, named the way the JS key table names it. */
internal data class TerminalKeyChord(
  val key: String,
  val ctrl: Boolean,
  val alt: Boolean,
  val shift: Boolean
) {
  fun toEventPayload(): Map<String, Any> =
    mapOf("key" to key, "ctrl" to ctrl, "alt" to alt, "shift" to shift)

  companion object {
    private val namedKeys = mapOf(
      KeyEvent.KEYCODE_ESCAPE to "Escape",
      KeyEvent.KEYCODE_TAB to "Tab",
      KeyEvent.KEYCODE_DPAD_UP to "ArrowUp",
      KeyEvent.KEYCODE_DPAD_DOWN to "ArrowDown",
      KeyEvent.KEYCODE_DPAD_LEFT to "ArrowLeft",
      KeyEvent.KEYCODE_DPAD_RIGHT to "ArrowRight",
      KeyEvent.KEYCODE_MOVE_HOME to "Home",
      KeyEvent.KEYCODE_MOVE_END to "End",
      KeyEvent.KEYCODE_PAGE_UP to "PageUp",
      KeyEvent.KEYCODE_PAGE_DOWN to "PageDown",
      KeyEvent.KEYCODE_INSERT to "Insert",
      KeyEvent.KEYCODE_FORWARD_DEL to "Delete",
      KeyEvent.KEYCODE_F1 to "F1",
      KeyEvent.KEYCODE_F2 to "F2",
      KeyEvent.KEYCODE_F3 to "F3",
      KeyEvent.KEYCODE_F4 to "F4",
      KeyEvent.KEYCODE_F5 to "F5",
      KeyEvent.KEYCODE_F6 to "F6",
      KeyEvent.KEYCODE_F7 to "F7",
      KeyEvent.KEYCODE_F8 to "F8",
      KeyEvent.KEYCODE_F9 to "F9",
      KeyEvent.KEYCODE_F10 to "F10",
      KeyEvent.KEYCODE_F11 to "F11",
      KeyEvent.KEYCODE_F12 to "F12"
    )

    /**
     * Which key-down the terminal takes from the hidden field. `baseChar` is the key's character with
     * no modifiers applied (`KeyEvent.getUnicodeChar(0)`). Plain printable keys, Backspace and Enter
     * return null: they reach the PTY through the field's text mirror and submit, as before.
     */
    fun fromKeyDown(keyCode: Int, metaState: Int, baseChar: Int): TerminalKeyChord? {
      // Why: Meta (Cmd/Search) chords belong to the system and the launcher.
      if (metaState and KeyEvent.META_META_ON != 0) {
        return null
      }
      val ctrl = metaState and KeyEvent.META_CTRL_ON != 0
      // Why: right Alt is AltGr on many layouts and types characters; a bare META_ALT_ON is a
      // keyboard app that names no side.
      val alt = metaState and KeyEvent.META_ALT_LEFT_ON != 0 ||
        (metaState and KeyEvent.META_ALT_ON != 0 && metaState and KeyEvent.META_ALT_RIGHT_ON == 0)
      val shift = metaState and KeyEvent.META_SHIFT_ON != 0
      namedKeys[keyCode]?.let { return TerminalKeyChord(it, ctrl, alt, shift) }
      if (!ctrl && !alt) {
        return null
      }
      if (baseChar and KeyCharacterMap.COMBINING_ACCENT != 0 || baseChar < 0x20 || baseChar > 0x7e) {
        return null
      }
      return TerminalKeyChord(baseChar.toChar().toString(), ctrl, alt, shift)
    }
  }
}
