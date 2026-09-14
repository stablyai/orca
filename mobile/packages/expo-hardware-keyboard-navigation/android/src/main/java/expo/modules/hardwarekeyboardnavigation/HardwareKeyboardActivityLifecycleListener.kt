package expo.modules.hardwarekeyboardnavigation

import android.app.Activity
import android.os.Bundle
import expo.modules.core.interfaces.ReactActivityLifecycleListener

class HardwareKeyboardActivityLifecycleListener : ReactActivityLifecycleListener {
  override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
    install(activity)
  }

  override fun onResume(activity: Activity) {
    install(activity)
  }

  override fun onDestroy(activity: Activity) {
    val callback = activity.window.callback
    if (callback is HardwareKeyboardWindowCallback) {
      activity.window.callback = callback.delegate
    }
  }

  private fun install(activity: Activity) {
    val callback = activity.window.callback
    if (callback !is HardwareKeyboardWindowCallback) {
      activity.window.callback = HardwareKeyboardWindowCallback(callback)
    }
  }
}
