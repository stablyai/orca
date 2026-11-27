import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import type { Store } from '../../persistence/loading-store/store'
import { previewGhosttyImport } from '../../ghostty/index'
import { previewKittyImport } from '../../kitty/index'
import { previewWarpThemeImport } from '../../warp-themes/index'

// Omitted sources fall back to each importer's auto-discovery default.
export function registerSettingsImportHandlers(
  store: Store,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle('settings:previewGhosttyImport', (event, source?: unknown) =>
    previewGhosttyImport(store, source, event.sender)
  )
  ipc.handle('settings:previewKittyImport', (event, source?: unknown) =>
    previewKittyImport(store, source, event.sender)
  )
  ipc.handle('settings:previewWarpThemeImport', (event, source?: unknown) =>
    previewWarpThemeImport(store, source, event.sender)
  )
}
