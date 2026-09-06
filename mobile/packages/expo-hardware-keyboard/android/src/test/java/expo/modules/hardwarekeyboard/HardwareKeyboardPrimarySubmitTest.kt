package expo.modules.hardwarekeyboard

import android.view.KeyEvent
import android.view.KeyCharacterMap
import android.view.inputmethod.BaseInputConnection
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.bridge.NativeModule
import com.facebook.react.views.textinput.ReactEditText
import expo.modules.kotlin.AppContext
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class HardwareKeyboardPrimarySubmitTest {
  private class Fixture(primary: Boolean = true) {
    private val application = RuntimeEnvironment.getApplication()
    private val reactContext = object : HardwareKeyboardRecordingContext(application) {
      override fun getNativeModules(): MutableCollection<NativeModule> = mutableListOf()
    }
    val context = ThemedReactContext(reactContext, application, "test", 1).also {
      DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(it)
    }
    private val unsafeClass = Class.forName("sun.misc.Unsafe")
    private val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
    private val appContext = unsafeClass.getMethod("allocateInstance", Class::class.java)
      .invoke(unsafe, AppContext::class.java) as AppContext
    val capture = HardwareKeyboardCaptureView(context, appContext).apply {
      captureMode = "submit"
      submitWithPrimaryModifier = primary
    }
    val input = ReactEditText(context)
    init {
      capture.addView(input)
      input.requestFocusFromJS()
      input.setText("draft")
      assertTrue(input.hasFocus())
    }
    fun key(meta: Int = KeyEvent.META_CTRL_ON, action: Int = KeyEvent.ACTION_DOWN,
      repeat: Int = 0, deviceId: Int = 1, code: Int = KeyEvent.KEYCODE_ENTER,
      flags: Int = 0) = capture.dispatchKeyEvent(
        KeyEvent(0, 0, action, code, repeat, meta, deviceId, 0, flags)
      )
  }

  @Test fun primarySubmitOwnsDownRepeatAndReleaseWithoutEditingTheDraft() {
    val fixture = Fixture()
    assertTrue(fixture.key())
    assertTrue(fixture.key(repeat = 1))
    assertTrue(fixture.key(meta = 0, action = KeyEvent.ACTION_UP))
    assertEquals("draft", fixture.input.text.toString())
    assertTrue(fixture.key(code = KeyEvent.KEYCODE_NUMPAD_ENTER))
  }

  @Test fun plainShiftAndOtherModifierReturnsAreDelegated() {
    val fixture = Fixture()
    for (meta in listOf(0, KeyEvent.META_SHIFT_ON, KeyEvent.META_ALT_ON,
      KeyEvent.META_META_ON, KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON,
      KeyEvent.META_CTRL_ON or KeyEvent.META_ALT_ON, KeyEvent.META_CTRL_ON or KeyEvent.META_META_ON)) {
      assertFalse(fixture.key(meta = meta))
      assertFalse(fixture.key(meta = meta, action = KeyEvent.ACTION_UP))
    }
  }

  @Test fun legacySubmitStillOwnsOnlyPlainReturn() {
    val fixture = Fixture(primary = false)
    assertTrue(fixture.key(meta = 0))
    assertTrue(fixture.key(meta = 0, action = KeyEvent.ACTION_UP))
    assertFalse(fixture.key())
  }

  @Test fun composingDisabledAndSoftwareEventsCannotSubmit() {
    val fixture = Fixture()
    assertFalse(fixture.key(deviceId = KeyCharacterMap.VIRTUAL_KEYBOARD))
    assertFalse(fixture.key(flags = KeyEvent.FLAG_SOFT_KEYBOARD))
    BaseInputConnection.setComposingSpans(fixture.input.text!!)
    assertFalse(fixture.key())
    BaseInputConnection.removeComposingSpans(fixture.input.text!!)
    fixture.capture.captureEnabled = false
    assertFalse(fixture.key())
  }

  @Test fun releaseOwnershipRemainsDeviceScopedAndClearsOnBlur() {
    val fixture = Fixture()
    assertTrue(fixture.key())
    assertFalse(fixture.key(action = KeyEvent.ACTION_UP, deviceId = 2))
    assertTrue(fixture.key(action = KeyEvent.ACTION_UP))
    assertTrue(fixture.key())
    fixture.capture.onWindowFocusChanged(false)
    assertFalse(fixture.key(action = KeyEvent.ACTION_UP))
  }
}
