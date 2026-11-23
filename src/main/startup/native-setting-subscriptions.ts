import type { NativeSettingsProjection } from '../core-desktop/native-settings-projection'
import type { MainThreadHangWatchdogHandle } from '../hang-watchdog/main-thread-hang-watchdog'
import { switchBrowserExtensionSupport } from '../browser/extensions/browser-extension-startup'
import { writeHttp1CompatibilityMarker } from './network-compatibility/http1-compatibility-marker'
import { syncNotchAgentStatus } from '../notch/notch-desktop-lifecycle'
import { syncMacMenuBarIcon } from './main-window/main-window-actions'

/** Main's native effects of settings changes: the pre-ready HTTP/1 marker, extensions and menu-bar icon. */
export function followNativeSettingChanges(
  nativeSettings: NativeSettingsProjection,
  options: {
    canonicalUserDataPath: string
    profileId: string
    hangWatchdog: MainThreadHangWatchdogHandle | null
  }
): void {
  nativeSettings.onSettingsChanged((updates, settings) => {
    if ('electronHttp1CompatibilityMode' in updates) {
      writeHttp1CompatibilityMarker(
        options.canonicalUserDataPath,
        settings.electronHttp1CompatibilityMode === true,
        options.profileId
      )
    }
    if ('browserExtensionsEnabled' in updates) {
      void switchBrowserExtensionSupport(settings.browserExtensionsEnabled !== false)
    }
    if ('showNotchAgentStatus' in updates) {
      syncNotchAgentStatus()
    }
    if ('showMenuBarIcon' in updates) {
      options.hangWatchdog?.setMenuBarIconSetting(settings.showMenuBarIcon !== false)
      // Store owns settings mutations; sync every menu-bar toggle through this listener.
      syncMacMenuBarIcon(settings.showMenuBarIcon !== false)
    }
  })
}
