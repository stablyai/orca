package expo.modules.orcaterminalkeycapture

import android.view.KeyEvent

/**
 * A key-down taken from the terminal field, in the vocabulary `buildTerminalShortcutKey` accepts:
 * a special-key id, or one printable ASCII character that already has Shift applied.
 */
data class TerminalKeyChord(
  val key: String,
  val ctrl: Boolean,
  val alt: Boolean,
  val shift: Boolean
) {
  fun toPayload(): Map<String, Any> =
    mapOf("key" to key, "ctrl" to ctrl, "alt" to alt, "shift" to shift)

  companion object {
    private val specialKeys = mapOf(
      KeyEvent.KEYCODE_ESCAPE to "escape",
      KeyEvent.KEYCODE_TAB to "tab",
      KeyEvent.KEYCODE_ENTER to "enter",
      KeyEvent.KEYCODE_NUMPAD_ENTER to "enter",
      KeyEvent.KEYCODE_SPACE to "space",
      KeyEvent.KEYCODE_FORWARD_DEL to "delete",
      KeyEvent.KEYCODE_INSERT to "insert",
      KeyEvent.KEYCODE_DPAD_UP to "arrowUp",
      KeyEvent.KEYCODE_DPAD_DOWN to "arrowDown",
      KeyEvent.KEYCODE_DPAD_LEFT to "arrowLeft",
      KeyEvent.KEYCODE_DPAD_RIGHT to "arrowRight",
      KeyEvent.KEYCODE_MOVE_HOME to "home",
      KeyEvent.KEYCODE_MOVE_END to "end",
      KeyEvent.KEYCODE_PAGE_UP to "pageUp",
      KeyEvent.KEYCODE_PAGE_DOWN to "pageDown",
      KeyEvent.KEYCODE_F1 to "f1",
      KeyEvent.KEYCODE_F2 to "f2",
      KeyEvent.KEYCODE_F3 to "f3",
      KeyEvent.KEYCODE_F4 to "f4",
      KeyEvent.KEYCODE_F5 to "f5",
      KeyEvent.KEYCODE_F6 to "f6",
      KeyEvent.KEYCODE_F7 to "f7",
      KeyEvent.KEYCODE_F8 to "f8",
      KeyEvent.KEYCODE_F9 to "f9",
      KeyEvent.KEYCODE_F10 to "f10",
      KeyEvent.KEYCODE_F11 to "f11",
      KeyEvent.KEYCODE_F12 to "f12"
    )

    // Why: without Ctrl or Alt these stay with the field, where Enter submits and Space is text.
    private val fieldOwnedBareKeys = setOf("enter", "space")

    /**
     * Returns the chord to send, or null to leave the key-down with the field. [baseChar] is the
     * layout's character with Ctrl, Alt and Meta removed but Shift kept; [altGrChar] is the
     * character the layout gives right Alt, or 0.
     */
    fun from(
      keyCode: Int,
      baseChar: Int,
      altGrChar: Int,
      ctrl: Boolean,
      alt: Boolean,
      shift: Boolean,
      meta: Boolean
    ): TerminalKeyChord? {
      // Why: the field already turns every Backspace into PTY erases, Ctrl+Backspace (Unexpected
      // Keyboard's delete-word key) included, so taking it here would erase twice.
      if (keyCode == KeyEvent.KEYCODE_DEL || meta) {
        return null
      }
      val special = specialKeys[keyCode]
      if (special != null) {
        if (special in fieldOwnedBareKeys && !ctrl && !alt) {
          return null
        }
        return TerminalKeyChord(special, ctrl, alt, shift)
      }
      if (!ctrl && !alt) {
        return null
      }
      // Why: AltGr layouts type characters through right Alt. Left Alt stays an Esc prefix even
      // where the stock kcm gives it accents (Alt+c is ç there).
      if (alt && !ctrl && altGrChar != 0) {
        return null
      }
      // Why: Ctrl+Shift+V stays the field's paste shortcut, as in Linux terminals.
      if (ctrl && shift && keyCode == KeyEvent.KEYCODE_V) {
        return null
      }
      val char = when {
        baseChar in 0x21..0x7e -> baseChar
        // Why: a Cyrillic or Greek layout still sends Ctrl+C on the C key; read the letter from it.
        ctrl && keyCode in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> 'a'.code + keyCode - KeyEvent.KEYCODE_A
        else -> return null
      }
      return TerminalKeyChord(char.toChar().toString(), ctrl, alt, shift = false)
    }
  }
}
