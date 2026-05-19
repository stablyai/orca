import type { autoUpdater as electronUpdaterAutoUpdater } from 'electron-updater'

export type ElectronAutoUpdater = typeof electronUpdaterAutoUpdater

export function loadElectronAutoUpdater(): ElectronAutoUpdater {
  // Why: electron-updater validates app.getVersion() while loading. Keep the
  // require behind packaged-update guards so direct dev/E2E launches do not
  // fail before setupAutoUpdater() can return.
  return (require('electron-updater') as { autoUpdater: ElectronAutoUpdater }).autoUpdater
}
