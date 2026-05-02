import { ipcMain, nativeTheme } from 'electron'
import type { Store } from '../persistence'
import type { GlobalSettings, PersistedState } from '../../shared/types'
import { listSystemFontFamilies } from '../system-fonts'
import { previewGhosttyImport } from '../ghostty/index'
import { rebuildAppMenu } from '../menu/register-app-menu'

// Why: fields that appear in the View > Appearance submenu need the menu
// rebuilt after any update so the checkbox `checked` state stays in sync
// with the persisted value. Electron doesn't reactively re-render menu
// items when the backing state changes.
const APPEARANCE_MENU_KEYS: readonly (keyof GlobalSettings)[] = [
  'showTasksButton',
  'showTitlebarAgentActivity'
]

export function registerSettingsHandlers(store: Store): void {
  ipcMain.handle('settings:get', () => {
    return store.getSettings()
  })

  ipcMain.handle('settings:set', (_event, args: Partial<GlobalSettings>) => {
    if (args.theme) {
      nativeTheme.themeSource = args.theme
    }
    const result = store.updateSettings(args)
    if (APPEARANCE_MENU_KEYS.some((key) => key in args)) {
      rebuildAppMenu()
    }
    return result
  })

  ipcMain.handle('settings:listFonts', () => {
    return listSystemFontFamilies()
  })

  ipcMain.handle('settings:previewGhosttyImport', () => {
    return previewGhosttyImport(store)
  })

  ipcMain.handle('cache:getGitHub', () => {
    return store.getGitHubCache()
  })

  ipcMain.handle('cache:setGitHub', (_event, args: { cache: PersistedState['githubCache'] }) => {
    store.setGitHubCache(args.cache)
  })
}
