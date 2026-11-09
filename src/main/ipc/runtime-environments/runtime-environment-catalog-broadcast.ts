import { BrowserWindow } from 'electron'
import { RUNTIME_ENVIRONMENT_CATALOG_CHANGED_CHANNEL } from '../../../shared/remote-runtime/host-catalog/runtime-environment-catalog-channel'

const catalogListeners = new Set<() => void>()

/** Main-process readers of the saved server list; renderers hear the IPC channel instead. */
export function onRuntimeEnvironmentCatalogChanged(listener: () => void): () => void {
  catalogListeners.add(listener)
  return () => catalogListeners.delete(listener)
}

export function publishRuntimeEnvironmentCatalogChanged(): void {
  for (const listener of catalogListeners) {
    listener()
  }
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
