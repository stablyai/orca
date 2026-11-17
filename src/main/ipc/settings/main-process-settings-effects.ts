import { nativeTheme } from 'electron'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { setMainUiLanguage } from '../../i18n/main-i18n'
import { rebuildAppMenu } from '../../menu/register-app-menu'
import { rebuildSystemTrayMenu } from '../../tray/system-tray'

// Electron menus do not react to settings; rebuild appearance checkboxes after writes.
const APPEARANCE_MENU_KEYS: readonly (keyof GlobalSettings)[] = [
  'showTasksButton',
  'showAutomationsButton',
  'showMobileButton',
  'showTitlebarAppName'
]

// Shared by the renderer's settings:set and file-driven applies so both reach native theme, language and menus.
export async function applyMainProcessSettingsEffects(
  changed: Partial<GlobalSettings>,
  settings: GlobalSettings
): Promise<void> {
  if (changed.theme) {
    nativeTheme.themeSource = changed.theme
  }
  if ('uiLanguage' in changed) {
    await setMainUiLanguage(settings.uiLanguage)
    rebuildAppMenu()
    rebuildSystemTrayMenu()
  }
  if (APPEARANCE_MENU_KEYS.some((key) => key in changed)) {
    rebuildAppMenu()
  }
}
