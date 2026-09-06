package expo.modules.hardwarekeyboard

import android.view.KeyEvent
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE, shadows = [HardwareKeyboardAlternateCharacterMap::class])
class HardwareKeyboardAlternateLayoutTest {
  @Test fun synthesizedAltGrKeepsNativeTextAndNeverClaimsARelease() {
    for (shift in listOf(0, KeyEvent.META_SHIFT_ON)) {
      val fixture = HardwareKeyboardNativeBoundaryTest.Fixture()
      val meta = KeyEvent.META_CTRL_ON or KeyEvent.META_ALT_ON or shift
      assertFalse(fixture.key(KeyEvent.KEYCODE_Q, meta = meta))
      assertEquals("first", fixture.input.text.toString())
      assertTrue(fixture.context.events.isEmpty())
      assertFalse(fixture.key(KeyEvent.KEYCODE_Q, KeyEvent.ACTION_UP, meta = meta))
    }
  }

  @Test fun ordinaryCtrlStillCapturesTheLogicalKeyAndFieldBoundary() {
    val fixture = HardwareKeyboardNativeBoundaryTest.Fixture()
    assertTrue(fixture.key(KeyEvent.KEYCODE_Q, meta = KeyEvent.META_CTRL_ON))
    assertEquals("q", fixture.lastKey()["key"])
    assertEquals("first", (fixture.lastKey()["fieldBoundary"] as Map<*, *>)["text"])
    assertEquals("", fixture.input.text.toString())
    assertTrue(fixture.key(KeyEvent.KEYCODE_Q, KeyEvent.ACTION_UP))
  }
}
