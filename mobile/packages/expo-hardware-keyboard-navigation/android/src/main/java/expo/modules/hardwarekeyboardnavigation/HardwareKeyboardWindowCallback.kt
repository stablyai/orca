package expo.modules.hardwarekeyboardnavigation

import android.view.KeyEvent
import android.view.Window

class HardwareKeyboardWindowCallback(
  val delegate: Window.Callback
) : Window.Callback by delegate {
  override fun dispatchKeyEvent(event: KeyEvent): Boolean =
    HardwareKeyboardNavigationRegistry.dispatch(event) || delegate.dispatchKeyEvent(event)
}
