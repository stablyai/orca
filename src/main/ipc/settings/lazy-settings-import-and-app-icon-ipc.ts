import { ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

const SETTINGS_IMPORT_CHANNELS = [
  'settings:previewGhosttyImport',
  'settings:previewKittyImport',
  'settings:previewWarpThemeImport'
] as const

const CUSTOM_APP_ICON_CHANNELS = [
  'appIcon:importCustom',
  'appIcon:readCustomPreview',
  'appIcon:removeCustom'
] as const

export function registerLazySettingsImportAndAppIconHandlers(store: Store): void {
  for (const channel of SETTINGS_IMPORT_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(SETTINGS_IMPORT_CHANNELS, async (ipc) => {
    const { registerSettingsImportHandlers } = await import('./settings-import-handlers')
    registerSettingsImportHandlers(store, ipc)
  })
  for (const channel of CUSTOM_APP_ICON_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(CUSTOM_APP_ICON_CHANNELS, async (ipc) => {
    const { registerCustomAppIconHandlers } = await import('../custom-app-icon')
    registerCustomAppIconHandlers(store, ipc)
  })
}
