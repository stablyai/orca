package expo.modules.orcaplaystorepresence

import android.content.pm.PackageManager
import android.os.Build
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

    // Play updates the installs it made; anything else was sideloaded from GitHub Releases.
    Function("isInstalledByPlayStore") {
      val context = appContext.reactContext ?: return@Function false
      val packageManager = context.packageManager
      try {
        val installer =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            packageManager.getInstallSourceInfo(context.packageName).installingPackageName
          } else {
            @Suppress("DEPRECATION")
            packageManager.getInstallerPackageName(context.packageName)
          }
        installer == PLAY_STORE_PACKAGE
      } catch (_: PackageManager.NameNotFoundException) {
        false
      }
    }
  }
}
