import { BrowserWindow } from 'electron'
import { RUNTIME_ENVIRONMENT_CATALOG_CHANGED_CHANNEL } from '../../../shared/runtime-environment-catalog-channel'

export function publishRuntimeEnvironmentCatalogChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(RUNTIME_ENVIRONMENT_CATALOG_CHANGED_CHANNEL)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}
