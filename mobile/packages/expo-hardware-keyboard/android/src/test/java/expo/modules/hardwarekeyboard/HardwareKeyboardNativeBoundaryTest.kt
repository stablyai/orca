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
    fun key(code: Int, action: Int = KeyEvent.ACTION_DOWN, repeat: Int = 0, deviceId: Int = 1,
      meta: Int = 0, flags: Int = 0) =
      capture.dispatchKeyEventPreIme(KeyEvent(0, 0, action, code, repeat, meta, deviceId, 0, flags))
    fun lastKey(): Map<*, *> = context.events.last().javaClass.getDeclaredField("hardwareKey").let {
      it.isAccessible = true
      it.get(context.events.last()) as Map<*, *>
    }
  }

  @Test fun optedInPasteUsesOneFieldBoundaryAndDoesNotResetOnRepeat() {
    val fixture = Fixture()
    fixture.capture.hardwarePaste = true
    val meta = KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON
    assertTrue(fixture.key(KeyEvent.KEYCODE_V, meta = meta))
    assertEquals("Paste", fixture.lastKey()["key"])
    assertEquals("first", (fixture.lastKey()["fieldBoundary"] as Map<*, *>)["text"])
    assertEquals("", fixture.input.text.toString())
    fixture.input.append("x")
    assertTrue(fixture.key(KeyEvent.KEYCODE_V, meta = meta, repeat = 1))
    assertTrue(fixture.key(KeyEvent.KEYCODE_V, meta = KeyEvent.META_CTRL_ON, repeat = 2))
    assertEquals("x", fixture.input.text.toString())
    assertEquals(1, fixture.context.events.size)
    assertFalse(fixture.key(KeyEvent.KEYCODE_V, KeyEvent.ACTION_UP, deviceId = 2))
    assertTrue(fixture.key(KeyEvent.KEYCODE_V, KeyEvent.ACTION_UP))
    assertTrue(fixture.key(KeyEvent.KEYCODE_V, meta = meta))
    assertEquals(2, fixture.context.events.size)
  }

  @Test fun pasteOptInDoesNotChangeCtrlVOrLegacyCtrlShiftV() {
    val fixture = Fixture()
    val meta = KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON
    assertTrue(fixture.key(KeyEvent.KEYCODE_V, meta = meta))
    assertEquals("v", fixture.lastKey()["key"])
    fixture.capture.hardwarePaste = true
    assertTrue(fixture.key(KeyEvent.KEYCODE_V, meta = KeyEvent.META_CTRL_ON))
    assertEquals("v", fixture.lastKey()["key"])
  }

  @Test fun composingSoftwareDisabledAndChatCannotCreatePasteBoundaries() {
    val meta = KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON
    for (variant in 0..5) {
      val fixture = Fixture()
      fixture.capture.hardwarePaste = true
      when (variant) {
        0 -> BaseInputConnection.setComposingSpans(fixture.input.text!!)
        1 -> fixture.capture.captureEnabled = false
        2 -> fixture.capture.captureMode = "submit"
        3 -> fixture.capture.nativeFieldBoundaries = false
      }
      fixture.key(KeyEvent.KEYCODE_V, meta = meta,
        deviceId = if (variant == 4) -1 else 1,
        flags = if (variant == 5) KeyEvent.FLAG_SOFT_KEYBOARD else 0)
      assertTrue(fixture.context.events.isEmpty())
      assertEquals("first", fixture.input.text.toString())
    }
  }

  @Test fun unavailableDispatcherAndBlurDoNotRetainPasteRepeatOwnership() {
    val fixture = Fixture()
    fixture.capture.hardwarePaste = true
    val meta = KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON
    fixture.context.dispatcherAvailable = false
    assertFalse(fixture.key(KeyEvent.KEYCODE_V, meta = meta))
    assertFalse(fixture.key(KeyEvent.KEYCODE_V, meta = meta, repeat = 1))
    fixture.context.dispatcherAvailable = true
    assertTrue(fixture.key(KeyEvent.KEYCODE_V, meta = meta))
    fixture.capture.onWindowFocusChanged(false)
    assertFalse(fixture.key(KeyEvent.KEYCODE_V, meta = meta, repeat = 1))
    assertFalse(fixture.key(KeyEvent.KEYCODE_V, KeyEvent.ACTION_UP))
  }

  @Test fun altAndMetaModifiedVAreNeverPasteActions() {
    for (extra in listOf(KeyEvent.META_ALT_ON, KeyEvent.META_META_ON)) {
      val fixture = Fixture()
      fixture.capture.hardwarePaste = true
      fixture.key(KeyEvent.KEYCODE_V,
        meta = KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON or extra)
      if (fixture.context.events.isNotEmpty()) assertNotEquals("Paste", fixture.lastKey()["key"])
    }
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
