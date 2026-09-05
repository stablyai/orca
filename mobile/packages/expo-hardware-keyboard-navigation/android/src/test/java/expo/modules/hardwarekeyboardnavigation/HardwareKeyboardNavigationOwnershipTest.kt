package expo.modules.hardwarekeyboardnavigation

import android.view.KeyEvent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class HardwareKeyboardNavigationOwnershipTest {
  private var sends = 0
  private val observer: (HardwareKeyboardCommand) -> Unit = { sends++ }
  private val reference = HardwareKeyboardNavigationRegistry.addObserver(observer)

  init {
    HardwareKeyboardNavigationRegistry.setCommands(listOf(
      HardwareKeyboardCommand("tab.previousRecent", "Tab", true, false, false, false)
    ))
  }

  private fun key(action: Int, repeat: Int = 0, device: Int = 1) = KeyEvent(
    0, 0, action, KeyEvent.KEYCODE_TAB, repeat, KeyEvent.META_CTRL_ON, device, 0
  )

  @After fun cleanup() {
    HardwareKeyboardNavigationRegistry.removeObserver(reference)
    HardwareKeyboardNavigationRegistry.setCommands(emptyList())
    HardwareKeyboardNavigationRegistry.clearCapturedKeys()
  }

  @Test fun ownedRepeatsAndReleaseNeverReachTerminalAfterNavigation() {
    assertTrue(HardwareKeyboardNavigationRegistry.dispatch(key(KeyEvent.ACTION_DOWN)))
    HardwareKeyboardNavigationRegistry.setCommands(emptyList())
    assertTrue(HardwareKeyboardNavigationRegistry.dispatch(key(KeyEvent.ACTION_DOWN, 1)))
    assertTrue(HardwareKeyboardNavigationRegistry.dispatch(key(KeyEvent.ACTION_UP)))
    assertFalse(HardwareKeyboardNavigationRegistry.dispatch(key(KeyEvent.ACTION_UP)))
    assertEquals(1, sends)
  }

  @Test fun compositionDoesNotStartCaptureButStillFinishesOwnedKeys() {
    assertFalse(HardwareKeyboardNavigationRegistry.dispatch(key(KeyEvent.ACTION_DOWN), false))
    assertTrue(HardwareKeyboardNavigationRegistry.dispatch(key(KeyEvent.ACTION_DOWN)))
    assertTrue(HardwareKeyboardNavigationRegistry.dispatch(key(KeyEvent.ACTION_DOWN, 1), false))
    assertTrue(HardwareKeyboardNavigationRegistry.dispatch(key(KeyEvent.ACTION_UP), false))
    assertEquals(1, sends)
  }

  @Test fun deviceOwnershipAndWindowCleanupDoNotSwallowUnrelatedKeys() {
    assertTrue(HardwareKeyboardNavigationRegistry.dispatch(key(KeyEvent.ACTION_DOWN)))
    assertFalse(HardwareKeyboardNavigationRegistry.dispatch(key(KeyEvent.ACTION_UP, device = 2)))
    HardwareKeyboardNavigationRegistry.clearCapturedKeys()
    assertFalse(HardwareKeyboardNavigationRegistry.dispatch(key(KeyEvent.ACTION_UP)))
    assertTrue(HardwareKeyboardNavigationRegistry.dispatch(key(KeyEvent.ACTION_DOWN)))
    assertEquals(2, sends)
  }
}
