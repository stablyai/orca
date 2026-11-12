import { BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import { CUSTOM_APP_ICON_ID, type CustomAppIconImportResult } from '../../shared/app-icon'
import { translateMain } from '../i18n/main-i18n'
import { showSingleFlightOpenDialog } from './single-flight-open-dialog'
import { applyAppIcon } from '../window/desktop-integration/app-icon'
import {
  CUSTOM_APP_ICON_FILE_EXTENSIONS,
  importCustomAppIcon,
  readCustomAppIconPreview,
  removeCustomAppIcon
} from '../window/desktop-integration/custom-app-icon'

export function registerCustomAppIconHandlers(store: Store): void {
  ipcMain.handle(
    'appIcon:importCustom',
    async (event): Promise<CustomAppIconImportResult | null> => {
      const result = await showSingleFlightOpenDialog(
        {
          title: translateMain('native.dialog.pickAppIcon', 'Choose app icon'),
          properties: ['openFile'],
          filters: [
            {
              name: translateMain('native.dialog.appIconImage', 'App icon image'),
              extensions: CUSTOM_APP_ICON_FILE_EXTENSIONS
            }
          ]
        },
        BrowserWindow.fromWebContents(event.sender)
      )
      const sourcePath = result.filePaths[0]
      if (result.canceled || !sourcePath) {
        return null
      }
      const imported = await importCustomAppIcon(sourcePath)
      // Replacing the active custom icon leaves the setting unchanged, so no settings write re-applies it.
      if (imported.ok && store.getSettings().appIcon === CUSTOM_APP_ICON_ID) {
        applyAppIcon(CUSTOM_APP_ICON_ID)
      }
      return imported
    }
  )

  ipcMain.handle('appIcon:readCustomPreview', (): string | null => readCustomAppIconPreview())

  ipcMain.handle('appIcon:removeCustom', async (): Promise<void> => {
    await removeCustomAppIcon()
  })
}
