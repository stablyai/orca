package expo.modules.orcaterminalkeycapture

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalKeyChordTest {
  private fun chord(
    keyCode: Int,
    baseChar: Char? = null,
    altGrChar: Char? = null,
    ctrl: Boolean = false,
    alt: Boolean = false,
    shift: Boolean = false,
    meta: Boolean = false
  ) = TerminalKeyChord.from(
    keyCode,
    baseChar?.code ?: 0,
    altGrChar?.code ?: 0,
    ctrl,
    alt,
    shift,
    meta
  )

  @Test
  fun ctrlAndAltChordsCarryTheShiftedCharacter() {
    assertEquals(TerminalKeyChord("c", true, false, false), chord(KeyEvent.KEYCODE_C, 'c', ctrl = true))
    assertEquals(
      TerminalKeyChord("@", true, false, false),
      chord(KeyEvent.KEYCODE_2, '@', ctrl = true, shift = true)
    )
    assertEquals(TerminalKeyChord("b", false, true, false), chord(KeyEvent.KEYCODE_B, 'b', alt = true))
    assertEquals(TerminalKeyChord("c", true, false, false), chord(KeyEvent.KEYCODE_C, '\u0441', ctrl = true))
  }

  @Test
  fun specialKeysAreTakenWithTheirModifiers() {
    assertEquals(TerminalKeyChord("escape", false, false, false), chord(KeyEvent.KEYCODE_ESCAPE))
    assertEquals(TerminalKeyChord("tab", false, false, true), chord(KeyEvent.KEYCODE_TAB, shift = true))
    assertEquals(TerminalKeyChord("enter", false, true, false), chord(KeyEvent.KEYCODE_ENTER, alt = true))
    assertEquals(TerminalKeyChord("space", true, false, false), chord(KeyEvent.KEYCODE_SPACE, ' ', ctrl = true))
  }

  @Test
  fun keysTheFieldOwnsAreLeftAlone() {
    assertNull(chord(KeyEvent.KEYCODE_A, 'a'))
    assertNull(chord(KeyEvent.KEYCODE_ENTER, shift = true))
    assertNull(chord(KeyEvent.KEYCODE_SPACE, ' '))
    assertNull(chord(KeyEvent.KEYCODE_DEL))
    assertNull(chord(KeyEvent.KEYCODE_DEL, ctrl = true))
    assertNull(chord(KeyEvent.KEYCODE_V, 'v', ctrl = true, shift = true))
    assertNull(chord(KeyEvent.KEYCODE_Q, 'q', altGrChar = '@', alt = true))
    assertNull(chord(KeyEvent.KEYCODE_C, 'c', meta = true))
  }
}
