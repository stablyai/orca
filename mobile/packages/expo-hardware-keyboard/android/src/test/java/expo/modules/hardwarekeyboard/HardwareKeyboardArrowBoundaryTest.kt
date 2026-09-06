package expo.modules.hardwarekeyboard

import android.text.InputType
import android.text.method.MetaKeyKeyListener
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import com.facebook.react.bridge.NativeModule
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.textinput.ReactEditText
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowKeyCharacterMap

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE)
class HardwareKeyboardArrowBoundaryTest {
  @Implements(KeyCharacterMap::class)
  class ToggledKeyCharacterMap : ShadowKeyCharacterMap() {
    @Implementation
    protected fun getModifierBehavior(): Int = KeyCharacterMap.MODIFIER_BEHAVIOR_CHORDED_OR_TOGGLED
  }

  private fun input(react: Boolean): EditText {
    val application = RuntimeEnvironment.getApplication()
    val input = if (react) {
      val reactContext = object : HardwareKeyboardRecordingContext(application) {
        override fun getNativeModules(): MutableCollection<NativeModule> = mutableListOf()
      }
      val context = ThemedReactContext(reactContext, application, "test", 1)
      DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(context)
      ReactEditText(context)
    } else EditText(application)
    input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    input.layoutParams = ViewGroup.LayoutParams(400, 200)
    input.setText("abc")
    input.measure(
      View.MeasureSpec.makeMeasureSpec(400, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY)
    )
    input.layout(0, 0, 400, 200)
    assertNotNull(input.layout)
    if (input is ReactEditText) input.requestFocusFromJS() else input.requestFocus()
    assertTrue(input.hasFocus())
    return input
  }

  private fun arrow(input: EditText, source: Int, code: Int = KeyEvent.KEYCODE_DPAD_LEFT,
    meta: Int = 0): Boolean = input.dispatchKeyEvent(KeyEvent(
      0, 0, KeyEvent.ACTION_DOWN, code, 0, meta, 1, 0, 0, source
    ))

  @Test fun keyboardSourceConsumesBoundaryArrowsInPlatformAndReactInputs() {
    for (react in listOf(false, true)) {
      val input = input(react)
      input.setSelection(0)
      assertTrue(arrow(input, InputDevice.SOURCE_KEYBOARD))
      assertEquals(0, input.selectionEnd)
      input.setSelection(input.length())
      assertTrue(arrow(input, InputDevice.SOURCE_KEYBOARD, KeyEvent.KEYCODE_DPAD_RIGHT))
      assertEquals(input.length(), input.selectionEnd)
    }
  }

  @Test fun dpadAndCombinedSourcesCanEscapeAtBoundaryInPlatformAndReactInputs() {
    for (react in listOf(false, true)) {
      for (source in listOf(InputDevice.SOURCE_DPAD,
        InputDevice.SOURCE_KEYBOARD or InputDevice.SOURCE_DPAD)) {
        val input = input(react)
        input.setSelection(0)
        assertFalse(arrow(input, source))
        assertEquals(0, input.selectionEnd)
      }
    }
  }

  @Test fun nativeInTextMovementWorksForKeyboardAndDpadSources() {
    for (react in listOf(false, true)) {
      for (source in listOf(InputDevice.SOURCE_KEYBOARD, InputDevice.SOURCE_DPAD)) {
        val input = input(react)
        input.setSelection(2)
        assertTrue(arrow(input, source))
        assertTrue(input.selectionEnd < 2)
        assertEquals(input.selectionStart, input.selectionEnd)
      }
    }
  }

  @Test
  @Config(shadows = [ToggledKeyCharacterMap::class])
  fun stockAndroidRedoCanLeaveShiftLatchedOnToggledKeyboards() {
    val input = input(false)
    input.setSelection(2)
    input.text.insert(2, "x")
    assertTrue(input.onKeyShortcut(KeyEvent.KEYCODE_Z, KeyEvent(
      0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_Z, 0, KeyEvent.META_CTRL_ON
    )))
    assertEquals("abc", input.text.toString())
    val metaKeys = object : MetaKeyKeyListener() {}
    val shiftDown = KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_SHIFT_LEFT, 0)
    val shiftUp = KeyEvent(0, 0, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_SHIFT_LEFT, 0)
    assertEquals(KeyCharacterMap.MODIFIER_BEHAVIOR_CHORDED_OR_TOGGLED,
      shiftUp.keyCharacterMap.modifierBehavior)
    assertTrue(metaKeys.onKeyDown(input, input.text, KeyEvent.KEYCODE_SHIFT_LEFT, shiftDown))
    assertTrue(input.onKeyShortcut(KeyEvent.KEYCODE_Z, KeyEvent(
      0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_Z, 0,
      KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON
    )))
    assertTrue(metaKeys.onKeyUp(input, input.text, KeyEvent.KEYCODE_SHIFT_LEFT, shiftUp))
    assertEquals("abxc", input.text.toString())
    assertEquals(1, MetaKeyKeyListener.getMetaState(input.text, KeyEvent.META_SHIFT_ON))
    input.setSelection(4)
    assertTrue(arrow(input, InputDevice.SOURCE_KEYBOARD or InputDevice.SOURCE_DPAD))
    assertEquals(4, input.selectionStart)
    // Robolectric's text layout does not reproduce device glyph advances.
    assertTrue(input.selectionEnd < input.selectionStart)
  }
}
