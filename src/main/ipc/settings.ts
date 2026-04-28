import { ipcMain, nativeTheme } from 'electron'
import type { Store } from '../persistence'
import type { GlobalSettings, PersistedState } from '../../shared/types'
import { listSystemFontFamilies } from '../system-fonts'
import { previewGhosttyImport } from '../ghostty/index'

export function registerSettingsHandlers(store: Store): void {
  ipcMain.handle('settings:get', () => {
    return store.getSettings()
  })

  ipcMain.handle('settings:set', (_event, args: Partial<GlobalSettings>) => {
    if (args.theme) {
      nativeTheme.themeSource = args.theme
    }
    return store.updateSettings(args)
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
