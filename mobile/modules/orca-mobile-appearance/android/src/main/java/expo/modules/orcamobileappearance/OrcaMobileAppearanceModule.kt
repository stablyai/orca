package expo.modules.orcamobileappearance

import android.content.ComponentCallbacks
import android.content.res.Configuration
import android.content.res.Resources
import android.graphics.Color
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.Window
import androidx.core.view.WindowCompat
import com.facebook.react.views.modal.ReactModalHostView
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OrcaMobileAppearanceModule : Module() {
  private var light: Boolean? = null
  private val configurationListener = object : ComponentCallbacks {
    override fun onConfigurationChanged(config: Configuration) { emitSystemAppearance() }
    override fun onLowMemory() {}
  }

  private fun systemScheme(): String {
    val config = appContext.reactContext?.applicationContext?.resources?.configuration
      ?: Resources.getSystem().configuration
    return if (config.uiMode.and(Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES) "dark" else "light"
  }

  private fun emitSystemAppearance() {
    sendEvent("systemColorSchemeChanged", mapOf("colorScheme" to systemScheme()))
  }
  private var background: Int? = null
  override fun definition() = ModuleDefinition {
    Name("OrcaMobileAppearance")
    Events("systemColorSchemeChanged")
    Function("getSystemColorScheme") { systemScheme() }
    OnCreate { appContext.reactContext?.applicationContext?.registerComponentCallbacks(configurationListener) }
    OnDestroy { appContext.reactContext?.applicationContext?.unregisterComponentCallbacks(configurationListener) }
    AsyncFunction("setColorScheme") { scheme: String, surface: String ->
      light = scheme != "dark"
      background = Color.parseColor(surface)
      applyWindowAppearance()
    }.runOnQueue(Queues.MAIN)
    OnActivityEntersForeground {
      // Expo can replay the current lifecycle while registering a module on the JS thread.
      appContext.currentActivity?.let { activity ->
        activity.runOnUiThread {
          activity.window.decorView.post {
            // AppState can coalesce a quick background/resume into no JS state change.
            emitSystemAppearance()
            applyWindowAppearance()
          }
        }
      }
    }
  }

  private fun applyWindowAppearance() {
    val activity = appContext.currentActivity ?: return
    val lightSurface = light ?: (activity.resources.configuration.uiMode
      .and(android.content.res.Configuration.UI_MODE_NIGHT_MASK) != android.content.res.Configuration.UI_MODE_NIGHT_YES)
    updateWindow(activity.window, lightSurface)
    background?.let { activity.window.decorView.setBackgroundColor(it) }
    updateDialogs(activity.window.decorView, lightSurface)
  }

  private fun updateDialogs(view: View, lightSurface: Boolean) {
    if (view is ReactModalHostView) {
      view.dialog?.window?.let { updateWindow(it, lightSurface) }
    }
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) updateDialogs(view.getChildAt(index), lightSurface)
    }
  }

  @Suppress("DEPRECATION")
  private fun updateWindow(window: Window, lightSurface: Boolean) {
    // The platform contrast scrim otherwise keeps the navigation bar light after a theme change.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.isNavigationBarContrastEnforced = false
    window.navigationBarColor = Color.TRANSPARENT
    WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightNavigationBars = lightSurface
  }
}
