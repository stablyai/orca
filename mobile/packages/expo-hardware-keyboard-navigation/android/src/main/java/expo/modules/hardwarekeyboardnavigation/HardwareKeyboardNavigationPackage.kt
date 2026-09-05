package expo.modules.hardwarekeyboardnavigation

import android.content.Context
import android.view.KeyEvent
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityHandler
import expo.modules.core.interfaces.ReactActivityLifecycleListener

class HardwareKeyboardNavigationPackage : Package {
  override fun createReactActivityLifecycleListeners(
    activityContext: Context
  ): List<ReactActivityLifecycleListener> = listOf(HardwareKeyboardActivityLifecycleListener())

  override fun createReactActivityHandlers(activityContext: Context): List<ReactActivityHandler> =
    listOf(object : ReactActivityHandler {
      override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean =
        event?.let(HardwareKeyboardNavigationRegistry::dispatch) ?: false
    })
}
