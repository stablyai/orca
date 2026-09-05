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
    return (!composing && HardwareKeyboardNavigationRegistry.dispatch(event)) || delegate.dispatchKeyEvent(event)
  }
}
