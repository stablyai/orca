package expo.modules.hardwarekeyboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class HardwareKeyboardFieldBoundaryEventTest {
  @Test fun resetUsesTheTextInputsNonCoalescingChangeStream() {
    val event = HardwareKeyboardFieldBoundaryEvent(7, 10, 2, emptyMap())
    assertEquals(7, event.surfaceId)
    assertEquals(10, event.viewTag)
    assertEquals("topChange", event.eventName)
    assertFalse(event.canCoalesce())
  }
}
