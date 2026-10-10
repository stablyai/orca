package expo.modules.orcaterminalkeycapture

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalKeyChordTest {
  private val ctrl = KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
  private val leftAlt = KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON
  private val rightAlt = KeyEvent.META_ALT_ON or KeyEvent.META_ALT_RIGHT_ON
  private val shift = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON

  @Test
  fun takesCtrlChordsAsTheirBaseCharacter() {
    assertEquals(
      TerminalKeyChord("c", ctrl = true, alt = false, shift = false),
      TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_C, ctrl, 'c'.code)
    )
    assertEquals(
      TerminalKeyChord("2", ctrl = true, alt = false, shift = true),
      TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_2, ctrl or shift, '2'.code)
    )
  }

  @Test
  fun takesLeftAltAndUnsidedAltButNotAltGr() {
    assertEquals(
      TerminalKeyChord("b", ctrl = false, alt = true, shift = false),
      TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_B, leftAlt, 'b'.code)
    )
    assertEquals(
      TerminalKeyChord("b", ctrl = false, alt = true, shift = false),
      TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_B, KeyEvent.META_ALT_ON, 'b'.code)
    )
    assertNull(TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_Q, rightAlt, 'q'.code))
  }

  @Test
  fun takesNamedKeysWithOrWithoutModifiers() {
    assertEquals(
      TerminalKeyChord("Escape", ctrl = false, alt = false, shift = false),
      TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_ESCAPE, 0, 0)
    )
    assertEquals(
      TerminalKeyChord("Tab", ctrl = false, alt = false, shift = true),
      TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_TAB, shift, '\t'.code)
    )
    assertEquals(
      TerminalKeyChord("ArrowUp", ctrl = true, alt = false, shift = false),
      TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_DPAD_UP, ctrl, 0)
    )
    assertEquals(
      TerminalKeyChord("F12", ctrl = false, alt = false, shift = false),
      TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_F12, 0, 0)
    )
  }

  @Test
  fun leavesTypingBackspaceEnterAndMetaChordsToTheField() {
    assertNull(TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_A, 0, 'a'.code))
    assertNull(TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_A, shift, 'a'.code))
    assertNull(TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_DEL, ctrl, 0))
    assertNull(TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_ENTER, ctrl, '\n'.code))
    assertNull(TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_C, ctrl or KeyEvent.META_META_ON, 'c'.code))
    assertNull(TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_ESCAPE, KeyEvent.META_META_ON, 0))
  }

  @Test
  fun leavesDeadKeysToTheField() {
    assertNull(
      TerminalKeyChord.fromKeyDown(KeyEvent.KEYCODE_GRAVE, ctrl, '`'.code or 0x80000000.toInt())
    )
  }
}
