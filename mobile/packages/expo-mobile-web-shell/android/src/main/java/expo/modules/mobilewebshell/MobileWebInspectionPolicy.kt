package expo.modules.mobilewebshell

import android.content.pm.ApplicationInfo

/**
 * DevTools also needs the OS debuggable flag, so a shipped production APK can never be opted in by Gradle alone.
 */
internal fun isMobileWebInspectionEnabled(
  applicationFlags: Int,
  isDebugBuild: Boolean = BuildConfig.DEBUG,
  isInspectableRelease: Boolean = BuildConfig.ORCA_INSPECTABLE_RELEASE
): Boolean {
  val isDebuggable = applicationFlags and ApplicationInfo.FLAG_DEBUGGABLE != 0
  return isDebuggable && (isDebugBuild || isInspectableRelease)
}
