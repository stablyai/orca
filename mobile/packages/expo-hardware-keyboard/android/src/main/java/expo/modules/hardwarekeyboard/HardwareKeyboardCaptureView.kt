package expo.modules.hardwarekeyboard

import android.content.Context
import android.view.KeyEvent
import android.view.KeyCharacterMap
import android.view.inputmethod.BaseInputConnection
import android.widget.EditText
import android.text.SpannableStringBuilder
import com.facebook.react.views.text.ReactTextUpdate
import com.facebook.react.views.textinput.ReactEditText
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.UIManagerHelper
import expo.modules.hardwarekeyboardnavigation.HardwareKeyboardNavigationRegistry
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * ViewGroup host for the RN TextInput. Intercepts terminal special keys and
 * Ctrl-modified printable keys on ACTION_DOWN. Native terminal boundaries also
 * own Enter; printable text, composition, and system shortcuts remain native.
 */
class HardwareKeyboardCaptureView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {

  private val onHardwareKey by EventDispatcher()

  var captureEnabled: Boolean = true
  var captureMode: String = "terminal"
  var submitWithPrimaryModifier: Boolean = false
  var nativeFieldBoundaries: Boolean = false
  private val capturedKeys = mutableSetOf<Pair<Int, Int>>()

  // Yoga owns child bounds; LinearLayout would collapse the hidden input after its siblings.
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

  override fun onDetachedFromWindow() {
    capturedKeys.clear()
    super.onDetachedFromWindow()
  }

  override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
    if (!hasWindowFocus) capturedKeys.clear()
    super.onWindowFocusChanged(hasWindowFocus)
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (nativeFieldBoundaries && captureMode == "terminal") return super.dispatchKeyEvent(event)
    return captureKeyEvent(event) { super.dispatchKeyEvent(event) }
  }

  override fun dispatchKeyEventPreIme(event: KeyEvent): Boolean {
    if (!nativeFieldBoundaries || captureMode != "terminal") return super.dispatchKeyEventPreIme(event)
    val input = findFocus() as? ReactEditText ?: return super.dispatchKeyEventPreIme(event)
    val composing = input.text?.let { BaseInputConnection.getComposingSpanStart(it) >= 0 } ?: false
    if (captureEnabled && isPhysicalKeyboardEvent(event) &&
      HardwareKeyboardNavigationRegistry.dispatch(event, canStartCapture = !composing)) return true
    return captureKeyEvent(event) { super.dispatchKeyEventPreIme(event) }
  }

  private fun captureKeyEvent(event: KeyEvent, fallback: () -> Boolean): Boolean {
    val identity = event.deviceId to event.keyCode
    if (event.action == KeyEvent.ACTION_UP && capturedKeys.remove(identity)) {
      return true
    }
    // A fresh down supersedes a release lost during device or focus changes.
    if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) capturedKeys.remove(identity)
    if (!captureEnabled || event.action != KeyEvent.ACTION_DOWN || !isPhysicalKeyboardEvent(event)) {
      return fallback()
    }

    val input = findFocus() as? EditText ?: return fallback()
    if (BaseInputConnection.getComposingSpanStart(input.text) >= 0) {
      return fallback()
    }

    val meta = event.metaState
    val hasMeta = (meta and KeyEvent.META_META_ON) != 0
    // Why: Meta stays system-owned so Cmd/Win shortcuts are not stolen.
    if (hasMeta) {
      return fallback()
    }

    val ctrl = (meta and KeyEvent.META_CTRL_ON) != 0
    val alt = (meta and KeyEvent.META_ALT_ON) != 0
    val shift = (meta and KeyEvent.META_SHIFT_ON) != 0
    val repeat = event.repeatCount > 0
    if (captureMode == "submit") {
      val enter = event.keyCode == KeyEvent.KEYCODE_ENTER || event.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
      if (!enter || ctrl != submitWithPrimaryModifier || alt || shift) {
        return fallback()
      }
      capturedKeys.add(identity)
      if (!repeat) {
        onHardwareKey(mapOf("key" to "Enter", "modifiers" to mapOf(
          "ctrl" to ctrl, "alt" to false, "shift" to false, "meta" to false
        ), "repeat" to false))
      }
      return true
    }

    // Legacy capture leaves Enter to TextInput's onSubmitEditing.
    if (
      event.keyCode == KeyEvent.KEYCODE_ENTER ||
      event.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
    ) {
      if (!nativeFieldBoundaries) return fallback()
    }

    // Why: Ctrl+Space switches input methods; must not become terminal NUL.
    if (ctrl && event.keyCode == KeyEvent.KEYCODE_SPACE) {
      return fallback()
    }

    val key = canonicalKey(event) ?: return fallback()
    if (nativeFieldBoundaries && !ctrl && !alt && !shift &&
      (key == "Backspace" || key == "Delete") && input.text.isNotEmpty()) return fallback()
    val isSpecial = isTerminalSpecialKey(key)
    val isAlternateLayoutPrintable =
      key.length == 1 &&
        ((meta and KeyEvent.META_ALT_RIGHT_ON) != 0 || producesAlternateLayoutText(event))
    // Why: AltGr and layout-specific Alt characters belong to TextInput even
    // when a keyboard reports AltGr as synthesized Ctrl+Alt.
    val isCtrlPrintable =
      ctrl && !isAlternateLayoutPrintable && key.length == 1 && key[0] in '!'..'~'

    if (!isSpecial && !isCtrlPrintable) {
      return fallback()
    }

    val payload = mutableMapOf<String, Any>(
        "key" to key,
        "modifiers" to mapOf(
          "ctrl" to ctrl,
          "alt" to alt,
          "shift" to shift,
          "meta" to false
        ),
        "repeat" to repeat
    )
    if (nativeFieldBoundaries && input is ReactEditText) {
      val reactContext = input.context as? ReactContext ?: return fallback()
      val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, input.id)
        ?: return fallback()
      capturedKeys.add(identity)
      val text = input.text.toString()
      val count = input.incrementAndGetEventCounter()
      input.maybeSetTextFromJS(ReactTextUpdate(
        SpannableStringBuilder(""), count, false, input.gravity, input.breakStrategy,
        if (android.os.Build.VERSION.SDK_INT >= 26) input.justificationMode else 0
      ))
      input.setSelection(0)
      payload["fieldBoundary"] = mapOf("text" to text, "eventCount" to count, "target" to input.id)
      dispatcher.dispatchEvent(HardwareKeyboardFieldBoundaryEvent(
        UIManagerHelper.getSurfaceId(input), input.id, count, payload
      ))
      return true
    }
    capturedKeys.add(identity)
    onHardwareKey(payload)
    return true
  }

  // Compare Alt with the same case modifiers so shifted AltGr text stays layout-owned.
  private fun producesAlternateLayoutText(event: KeyEvent): Boolean {
    val metaWithoutCtrl = event.metaState and KeyEvent.META_CTRL_MASK.inv()
    if ((metaWithoutCtrl and KeyEvent.META_ALT_MASK) == 0) {
      return false
    }
    val metaWithoutCtrlOrAlt = metaWithoutCtrl and KeyEvent.META_ALT_MASK.inv()
    val alternateCharacter = event.getUnicodeChar(metaWithoutCtrl)
    val baseCharacter = event.getUnicodeChar(metaWithoutCtrlOrAlt)
    return alternateCharacter != 0 && alternateCharacter != baseCharacter
  }

  private fun canonicalKey(event: KeyEvent): String? {
    return when (event.keyCode) {
      KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "Enter"
      KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
      KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
      KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
      KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
      KeyEvent.KEYCODE_ESCAPE -> "Escape"
      KeyEvent.KEYCODE_TAB -> "Tab"
      KeyEvent.KEYCODE_DEL -> "Backspace"
      KeyEvent.KEYCODE_FORWARD_DEL -> "Delete"
      KeyEvent.KEYCODE_MOVE_HOME -> "Home"
      KeyEvent.KEYCODE_MOVE_END -> "End"
      KeyEvent.KEYCODE_PAGE_UP -> "PageUp"
      KeyEvent.KEYCODE_PAGE_DOWN -> "PageDown"
      KeyEvent.KEYCODE_F1 -> "F1"
      KeyEvent.KEYCODE_F2 -> "F2"
      KeyEvent.KEYCODE_F3 -> "F3"
      KeyEvent.KEYCODE_F4 -> "F4"
      KeyEvent.KEYCODE_F5 -> "F5"
      KeyEvent.KEYCODE_F6 -> "F6"
      KeyEvent.KEYCODE_F7 -> "F7"
      KeyEvent.KEYCODE_F8 -> "F8"
      KeyEvent.KEYCODE_F9 -> "F9"
      KeyEvent.KEYCODE_F10 -> "F10"
      KeyEvent.KEYCODE_F11 -> "F11"
      KeyEvent.KEYCODE_F12 -> "F12"
      KeyEvent.KEYCODE_SPACE -> " "
      else -> {
        val label = event.displayLabel
        if (label != '\u0000' && !label.isISOControl()) {
          label.lowercaseChar().toString()
        } else {
          null
        }
      }
    }
  }

  private fun isTerminalSpecialKey(key: String): Boolean {
    return key == "Enter" || key == "ArrowUp" || key == "ArrowDown" || key == "ArrowLeft" || key == "ArrowRight" ||
      key == "Escape" || key == "Tab" || key == "Backspace" || key == "Delete" ||
      key == "Home" || key == "End" || key == "PageUp" || key == "PageDown" ||
      key.startsWith("F")
  }
}

internal fun isPhysicalKeyboardEvent(event: KeyEvent): Boolean =
  event.flags and KeyEvent.FLAG_SOFT_KEYBOARD == 0 &&
    event.deviceId != KeyCharacterMap.VIRTUAL_KEYBOARD && event.device?.isVirtual != true
