package expo.modules.hardwarekeyboard

import android.view.InputDevice
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import com.facebook.react.bridge.NativeModule
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.textinput.ReactEditText
import expo.modules.kotlin.AppContext
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowInputDevice
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE)
class HardwareKeyboardSubmitArrowTest {
  private class Fixture(keyboardType: Int = InputDevice.KEYBOARD_TYPE_ALPHABETIC) {
    private val application = RuntimeEnvironment.getApplication()
    private val reactContext = object : HardwareKeyboardRecordingContext(application) {
      override fun getNativeModules(): MutableCollection<NativeModule> = mutableListOf()
    }
    private val context = ThemedReactContext(reactContext, application, "test", 1).also {
      DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(it)
    }
    private val unsafeClass = Class.forName("sun.misc.Unsafe")
    private val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
    private val appContext = unsafeClass.getMethod("allocateInstance", Class::class.java)
      .invoke(unsafe, AppContext::class.java) as AppContext
    val capture = HardwareKeyboardCaptureView(context, appContext).apply { captureMode = "submit" }
    private val keyboardDevice = ShadowInputDevice.makeInputDeviceNamed("alphabetic keyboard").also {
      ReflectionHelpers.setField(it, "mId", 1)
      ReflectionHelpers.setField(it, "mKeyboardType", keyboardType)
    }
    var nativeHandled = false
    val delegated = mutableListOf<KeyEvent>()
    val input = object : ReactEditText(context) {
      override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        delegated.add(event)
        return nativeHandled
      }
    }
    init {
      capture.addView(input)
      capture.layout(0, 0, 400, 200)
      input.layout(0, 0, 400, 200)
      input.requestFocusFromJS()
      input.setText("draft")
      assertTrue(input.hasFocus())
    }
    fun key(code: Int = KeyEvent.KEYCODE_DPAD_RIGHT, action: Int = KeyEvent.ACTION_DOWN,
      source: Int = InputDevice.SOURCE_KEYBOARD or InputDevice.SOURCE_DPAD,
      meta: Int = 0, device: Int = 1, repeat: Int = 0, flags: Int = 0): Boolean =
      KeyEvent(0, 0, action, code, repeat, meta, device, 0, flags, source).let {
        if (device == 1) shadowOf(it).setDevice(keyboardDevice)
        capture.dispatchKeyEvent(it)
      }
  }

  @Test fun unhandledCombinedSourceArrowsKeepEditorAndOwnOnlyTheirDeviceRelease() {
    val fixture = Fixture()
    for (code in listOf(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
      KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN)) {
      assertTrue(fixture.key(code = code))
      assertTrue(fixture.key(code = code, repeat = 1))
      assertFalse(fixture.key(code = code, action = KeyEvent.ACTION_UP, device = 2))
      val delegated = fixture.delegated.size
      assertTrue(fixture.key(code = code, action = KeyEvent.ACTION_UP))
      assertEquals(delegated, fixture.delegated.size)
    }
    assertEquals("draft", fixture.input.text.toString())
  }

  @Test fun nativeHandledMovementAndReleaseRemainNative() {
    val fixture = Fixture()
    fixture.nativeHandled = true
    assertTrue(fixture.key())
    assertTrue(fixture.key(action = KeyEvent.ACTION_UP))
    assertEquals(listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP), fixture.delegated.map { it.action })
  }

  @Test fun composingDisabledModifiedAndNonKeyboardArrowsRemainDelegated() {
    val fixture = Fixture()
    BaseInputConnection.setComposingSpans(fixture.input.text!!)
    assertFalse(fixture.key())
    BaseInputConnection.removeComposingSpans(fixture.input.text!!)
    fixture.capture.captureEnabled = false
    assertFalse(fixture.key())
    fixture.capture.captureEnabled = true
    for (meta in listOf(KeyEvent.META_SHIFT_ON, KeyEvent.META_CTRL_ON,
      KeyEvent.META_ALT_ON, KeyEvent.META_META_ON)) assertFalse(fixture.key(meta = meta))
    assertFalse(fixture.key(source = InputDevice.SOURCE_DPAD))
    assertFalse(fixture.key(device = -1))
    assertFalse(fixture.key(flags = KeyEvent.FLAG_SOFT_KEYBOARD))
    assertFalse(fixture.key(code = KeyEvent.KEYCODE_TAB))
    assertEquals(10, fixture.delegated.size)
    assertFalse(Fixture(InputDevice.KEYBOARD_TYPE_NON_ALPHABETIC).key())
  }

  @Test fun blurClearsBoundaryReleaseOwnership() {
    val fixture = Fixture()
    assertTrue(fixture.key())
    fixture.capture.onWindowFocusChanged(false)
    assertFalse(fixture.key(action = KeyEvent.ACTION_UP))
  }
}
