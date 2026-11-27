import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { syncMacMenuBarIcon } from './main-window/main-window-actions'
import { syncNotchStatus } from './notch-status-wiring'

/** followNativeSettingChanges forwards every update here; the store owns the mutation. */
export function syncSystemPresenceSettingUpdate(
  updates: Partial<GlobalSettings>,
  settings: Pick<GlobalSettings, 'showMenuBarIcon' | 'showNotchStatus'>
): void {
  if ('showMenuBarIcon' in updates) {
    syncMacMenuBarIcon(settings.showMenuBarIcon !== false)
  }
  if ('showNotchStatus' in updates) {
    syncNotchStatus(settings.showNotchStatus === true)
  }
}
