package expo.modules.orcaappicon

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The launcher alias for the primary icon; alternates are AppIcon<Name>, as the config plugin declares.
private const val PRIMARY_ICON_NAME = "AppIcon"

private class UnknownAppIconException(name: String) :
  CodedException("ERR_APP_ICON", "No launcher alias for app icon $name", null)

class OrcaAppIconModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("OrcaAppIcon")

    AsyncFunction("supportsAlternateIcons") {
      iconAliases().size > 1
    }

    AsyncFunction("getAlternateIconName") {
      iconAliases()
        .firstOrNull { isEnabled(it) }
        ?.let { iconName(it) }
        ?.takeUnless { it == PRIMARY_ICON_NAME }
    }

    AsyncFunction("setAlternateIconName") { name: String? ->
      val aliases = iconAliases()
      val targetName = name ?: PRIMARY_ICON_NAME
      val target = aliases.firstOrNull { iconName(it) == targetName }
        ?: throw UnknownAppIconException(targetName)
      // Enable the new launcher entry before disabling the old one so one always exists.
      setEnabled(target, true)
      aliases.filter { it !== target }.forEach { setEnabled(it, false) }
    }
  }

  private fun iconAliases(): List<ResolveInfo> {
    val launcher = Intent(Intent.ACTION_MAIN)
      .addCategory(Intent.CATEGORY_LAUNCHER)
      .setPackage(context.packageName)
    @Suppress("DEPRECATION")
    return context.packageManager
      .queryIntentActivities(launcher, PackageManager.MATCH_DISABLED_COMPONENTS)
      .filter { iconName(it).startsWith(PRIMARY_ICON_NAME) }
  }

  private fun iconName(alias: ResolveInfo): String = alias.activityInfo.name.substringAfterLast('.')

  private fun componentName(alias: ResolveInfo) =
    ComponentName(alias.activityInfo.packageName, alias.activityInfo.name)

  private fun isEnabled(alias: ResolveInfo): Boolean =
    when (context.packageManager.getComponentEnabledSetting(componentName(alias))) {
      PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
      PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> alias.activityInfo.enabled
      else -> false
    }

  private fun setEnabled(alias: ResolveInfo, enabled: Boolean) {
    val state = if (enabled) {
      PackageManager.COMPONENT_ENABLED_STATE_ENABLED
    } else {
      PackageManager.COMPONENT_ENABLED_STATE_DISABLED
    }
    context.packageManager.setComponentEnabledSetting(
      componentName(alias),
      state,
      PackageManager.DONT_KILL_APP
    )
  }
}
