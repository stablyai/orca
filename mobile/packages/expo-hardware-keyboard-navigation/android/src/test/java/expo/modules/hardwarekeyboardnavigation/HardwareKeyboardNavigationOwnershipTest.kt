package expo.modules.hardwarekeyboardnavigation

import android.view.KeyEvent
import android.view.Window
import android.app.Activity
import android.view.inputmethod.BaseInputConnection
import android.widget.EditText
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Robolectric
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

  @Test fun activityFallbackDoesNotCaptureAnUnhandledComposingShortcut() {
    val controller = Robolectric.buildActivity(Activity::class.java).setup()
    try {
      val activity = controller.get()
      val input = EditText(activity)
      activity.setContentView(input)
      input.requestFocus()
      input.setText("composing")
      BaseInputConnection.setComposingSpans(input.text)
      assertTrue(BaseInputConnection.getComposingSpanStart(input.text) >= 0)
      val handler = HardwareKeyboardNavigationPackage().createReactActivityHandlers(activity).single()

      assertFalse(handler.onKeyDown(KeyEvent.KEYCODE_TAB, key(KeyEvent.ACTION_DOWN)))
      assertEquals(0, sends)

      BaseInputConnection.removeComposingSpans(input.text)
      assertTrue(handler.onKeyDown(KeyEvent.KEYCODE_TAB, key(KeyEvent.ACTION_DOWN)))
      assertEquals(1, sends)
    } finally {
      controller.pause().stop().destroy()
    }
  }

  @Test fun windowAndActivityFallbackShareCompositionAndFinishOwnedKeys() {
    val controller = Robolectric.buildActivity(Activity::class.java).setup()
    try {
      val activity = controller.get()
      val input = EditText(activity)
      activity.setContentView(input)
      input.requestFocus()
      input.setText("composing")
      assertTrue(activity.window.currentFocus === input)
      val handler = HardwareKeyboardNavigationPackage().createReactActivityHandlers(activity).single()
      var fallbacks = 0
      val delegate = object : Window.Callback by activity {
        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
          fallbacks++
          return event.action == KeyEvent.ACTION_DOWN && handler.onKeyDown(event.keyCode, event)
        }
      }
      val callback = HardwareKeyboardWindowCallback(delegate, activity.window)

      BaseInputConnection.setComposingSpans(input.text)
      assertFalse(callback.dispatchKeyEvent(key(KeyEvent.ACTION_DOWN)))
      assertEquals(1, fallbacks)
      assertEquals(0, sends)

      BaseInputConnection.removeComposingSpans(input.text)
      assertTrue(callback.dispatchKeyEvent(key(KeyEvent.ACTION_DOWN)))
      assertEquals(1, sends)
      BaseInputConnection.setComposingSpans(input.text)
      HardwareKeyboardNavigationRegistry.setCommands(emptyList())
      assertTrue(callback.dispatchKeyEvent(key(KeyEvent.ACTION_DOWN, 1)))
      assertTrue(callback.dispatchKeyEvent(key(KeyEvent.ACTION_UP)))
      assertEquals(1, fallbacks)
      assertEquals(1, sends)
      assertFalse(callback.dispatchKeyEvent(key(KeyEvent.ACTION_UP)))
      assertEquals(2, fallbacks)
    } finally {
      controller.pause().stop().destroy()
    }
  }
}
