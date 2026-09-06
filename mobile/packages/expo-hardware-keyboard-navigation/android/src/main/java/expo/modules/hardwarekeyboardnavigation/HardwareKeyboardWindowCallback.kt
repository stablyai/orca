package expo.modules.hardwarekeyboardnavigation

import android.view.KeyEvent
import android.view.Window

class HardwareKeyboardWindowCallback(
  val delegate: Window.Callback,
  private val window: Window
) : Window.Callback by delegate {
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    return HardwareKeyboardNavigationRegistry.dispatch(event, window) || delegate.dispatchKeyEvent(event)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    if (!hasFocus) {
      HardwareKeyboardNavigationRegistry.clearCapturedKeys()
    }
    delegate.onWindowFocusChanged(hasFocus)
  }
}
