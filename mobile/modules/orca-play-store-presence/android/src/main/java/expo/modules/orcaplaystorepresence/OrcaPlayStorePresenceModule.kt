package expo.modules.orcaplaystorepresence

import android.content.pm.PackageManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val PLAY_STORE_PACKAGE = "com.android.vending"

class OrcaPlayStorePresenceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OrcaPlayStorePresence")

    // Installed and enabled: a disabled Play Store cannot open the listing.
    Function("isPlayStoreInstalled") {
      val packageManager = appContext.reactContext?.packageManager ?: return@Function false
      try {
        @Suppress("DEPRECATION")
        packageManager.getApplicationInfo(PLAY_STORE_PACKAGE, 0).enabled
      } catch (_: PackageManager.NameNotFoundException) {
        false
      }
    }
  }
}
