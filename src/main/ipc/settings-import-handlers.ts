import { ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import { previewGhosttyImport } from '../ghostty/index'
import { previewKittyImport } from '../kitty'
import { previewWarpThemeImport } from '../warp-themes'

// Omitted sources fall back to each importer's auto-discovery default.
export function registerSettingsImportHandlers(store: Store): void {
  ipcMain.handle('settings:previewGhosttyImport', (event, source?: unknown) =>
    previewGhosttyImport(store, source, event.sender)
  )
  ipcMain.handle('settings:previewKittyImport', (event, source?: unknown) =>
    previewKittyImport(store, source, event.sender)
  )
  ipcMain.handle('settings:previewWarpThemeImport', (event, source?: unknown) =>
    previewWarpThemeImport(store, source, event.sender)
  )
}
