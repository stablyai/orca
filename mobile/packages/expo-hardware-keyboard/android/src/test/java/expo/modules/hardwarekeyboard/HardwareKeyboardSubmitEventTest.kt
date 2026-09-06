package expo.modules.hardwarekeyboard

import android.view.KeyCharacterMap
import android.view.KeyEvent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class HardwareKeyboardSubmitEventTest {
  private fun enter(deviceId: Int, flags: Int = 0) = KeyEvent(
    0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0, 0, deviceId, 0, flags
  )

  @Test fun softwareReturnIsNotHardwareSubmit() {
    assertFalse(isPhysicalKeyboardEvent(enter(1, KeyEvent.FLAG_SOFT_KEYBOARD)))
    assertFalse(isPhysicalKeyboardEvent(enter(KeyCharacterMap.VIRTUAL_KEYBOARD)))
    assertFalse(isPhysicalKeyboardEvent(enter(
      KeyCharacterMap.VIRTUAL_KEYBOARD,
      KeyEvent.FLAG_SOFT_KEYBOARD or KeyEvent.FLAG_KEEP_TOUCH_MODE
    )))
  }

  @Test fun physicalReturnRemainsEligible() {
    assertTrue(isPhysicalKeyboardEvent(enter(1)))
  }
}
