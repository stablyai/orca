package expo.modules.hardwarekeyboardnavigation

import android.view.KeyEvent
import android.view.Window
import android.widget.TextView
import android.view.inputmethod.BaseInputConnection

class HardwareKeyboardWindowCallback(
  val delegate: Window.Callback,
  private val window: Window
) : Window.Callback by delegate {
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val text = (window.currentFocus as? TextView)?.editableText
    val composing = text != null && BaseInputConnection.getComposingSpanStart(text) >= 0
    return HardwareKeyboardNavigationRegistry.dispatch(event, canStartCapture = !composing) || delegate.dispatchKeyEvent(event)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    if (!hasFocus) {
      HardwareKeyboardNavigationRegistry.clearCapturedKeys()
    }
    delegate.onWindowFocusChanged(hasFocus)
  }
}
