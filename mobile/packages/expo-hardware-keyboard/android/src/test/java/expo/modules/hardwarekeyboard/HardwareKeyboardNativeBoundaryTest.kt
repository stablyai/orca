package expo.modules.hardwarekeyboard

import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.facebook.react.views.text.ReactTextUpdate
import android.text.SpannableStringBuilder
import com.facebook.react.views.textinput.ReactEditText
import expo.modules.hardwarekeyboardnavigation.HardwareKeyboardCommand
import expo.modules.hardwarekeyboardnavigation.HardwareKeyboardNavigationRegistry
import expo.modules.kotlin.AppContext
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class HardwareKeyboardNativeBoundaryTest {
  private class Fixture {
    val context = HardwareKeyboardRecordingContext(RuntimeEnvironment.getApplication()).also {
      DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(it)
    }
    private val unsafeClass = Class.forName("sun.misc.Unsafe")
    private val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
    private val appContext = unsafeClass.getMethod("allocateInstance", Class::class.java)
      .invoke(unsafe, AppContext::class.java) as AppContext
    val capture = HardwareKeyboardCaptureView(context, appContext).apply { nativeFieldBoundaries = true }
    val input = ReactEditText(context).apply { id = 10 }
    init {
      capture.addView(input)
      input.requestFocusFromJS()
      input.setText("first")
      input.setSelection(5)
      assertTrue(input.hasFocus())
    }
    fun key(code: Int, action: Int = KeyEvent.ACTION_DOWN, repeat: Int = 0, deviceId: Int = 1) =
      capture.dispatchKeyEventPreIme(KeyEvent(0, 0, action, code, repeat, 0, deviceId, 0, 0))
  }

  @Test fun returnClearsRealNativeFieldBeforeTheNextEdit() {
    val fixture = Fixture()
    assertTrue(fixture.key(KeyEvent.KEYCODE_ENTER))
    assertEquals("", fixture.input.text.toString())
    assertEquals(0, fixture.input.selectionStart)
    assertEquals(1, fixture.context.events.size)
    assertEquals("topChange", fixture.context.events.single().eventName)
    fixture.input.append("x")
    assertEquals("x", fixture.input.text.toString())
    assertTrue(fixture.key(KeyEvent.KEYCODE_ENTER, KeyEvent.ACTION_UP))
    assertEquals(1, fixture.context.events.size)
  }

  @Test fun composingReturnLeavesNativeTextAndEventStreamUntouched() {
    val fixture = Fixture()
    BaseInputConnection.setComposingSpans(fixture.input.text!!)
    fixture.key(KeyEvent.KEYCODE_ENTER)
    assertEquals("first", fixture.input.text.toString())
    assertTrue(fixture.context.events.isEmpty())
  }

  @Test fun plainDeleteWithTextRemainsNativeOwned() {
    val fixture = Fixture()
    fixture.key(KeyEvent.KEYCODE_DEL)
    assertEquals("first", fixture.input.text.toString())
    assertTrue(fixture.context.events.isEmpty())
  }

  @Test fun unavailableDispatcherDoesNotClaimTheRelease() {
    val fixture = Fixture()
    fixture.context.dispatcherAvailable = false
    assertFalse(fixture.key(KeyEvent.KEYCODE_TAB))
    assertFalse(fixture.key(KeyEvent.KEYCODE_TAB, KeyEvent.ACTION_UP))
    assertEquals("first", fixture.input.text.toString())
    assertTrue(fixture.context.events.isEmpty())
  }

  @Test fun releaseFromAnotherKeyboardDoesNotConsumeTheCapturedRelease() {
    val fixture = Fixture()
    assertTrue(fixture.key(KeyEvent.KEYCODE_TAB))
    assertFalse(fixture.key(KeyEvent.KEYCODE_TAB, KeyEvent.ACTION_UP, deviceId = 2))
    assertTrue(fixture.key(KeyEvent.KEYCODE_TAB, KeyEvent.ACTION_UP))
  }

  @Test fun windowBlurDiscardsReleaseOwnership() {
    val fixture = Fixture()
    assertTrue(fixture.key(KeyEvent.KEYCODE_TAB))
    fixture.capture.onWindowFocusChanged(false)
    assertFalse(fixture.key(KeyEvent.KEYCODE_TAB, KeyEvent.ACTION_UP))
  }

  @Test fun freshUncapturedDownSupersedesALostRelease() {
    val fixture = Fixture()
    assertTrue(fixture.key(KeyEvent.KEYCODE_TAB))
    fixture.capture.captureEnabled = false
    assertFalse(fixture.key(KeyEvent.KEYCODE_TAB))
    assertFalse(fixture.key(KeyEvent.KEYCODE_TAB, KeyEvent.ACTION_UP))
  }

  @Test fun repeatedTerminalControlsRemainDistinctNativeBoundaries() {
    val fixture = Fixture()
    assertTrue(fixture.key(KeyEvent.KEYCODE_DPAD_UP))
    assertTrue(fixture.key(KeyEvent.KEYCODE_DPAD_UP, repeat = 1))
    assertTrue(fixture.key(KeyEvent.KEYCODE_DPAD_UP, repeat = 2))
    assertEquals(3, fixture.context.events.size)
    assertTrue(fixture.key(KeyEvent.KEYCODE_DPAD_UP, KeyEvent.ACTION_UP))
    assertEquals(3, fixture.context.events.size)
  }

  @Test fun staleControlledTextCannotRestoreTheFieldAfterNativeReset() {
    val fixture = Fixture()
    assertTrue(fixture.key(KeyEvent.KEYCODE_ENTER))
    fixture.input.append("x")
    fixture.input.maybeSetTextFromJS(ReactTextUpdate(
      SpannableStringBuilder("first"), 0, false, fixture.input.gravity,
      fixture.input.breakStrategy, fixture.input.justificationMode
    ))
    assertEquals("x", fixture.input.text.toString())
  }

  @Test fun registeredNavigationOwnsDownRepeatAndReleaseWithoutReset() {
    val fixture = Fixture()
    val command = HardwareKeyboardCommand("next", "Tab", false, false, false, false)
    val observed = mutableListOf<HardwareKeyboardCommand>()
    val observer: (HardwareKeyboardCommand) -> Unit = { observed.add(it) }
    val reference = HardwareKeyboardNavigationRegistry.addObserver(observer)
    HardwareKeyboardNavigationRegistry.setCommands(listOf(command))
    try {
      assertTrue(fixture.key(KeyEvent.KEYCODE_TAB))
      assertTrue(fixture.key(KeyEvent.KEYCODE_TAB, repeat = 1))
      assertTrue(fixture.key(KeyEvent.KEYCODE_TAB, KeyEvent.ACTION_UP))
      assertEquals(listOf(command), observed)
      assertEquals("first", fixture.input.text.toString())
      assertTrue(fixture.context.events.isEmpty())
    } finally {
      HardwareKeyboardNavigationRegistry.removeObserver(reference)
      HardwareKeyboardNavigationRegistry.setCommands(emptyList())
      HardwareKeyboardNavigationRegistry.clearCapturedKeys()
    }
  }
}
