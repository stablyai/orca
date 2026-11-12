import type { autoUpdater as electronUpdaterAutoUpdater } from 'electron-updater'

export type ElectronAutoUpdater = typeof electronUpdaterAutoUpdater

export function loadElectronAutoUpdater(): ElectronAutoUpdater {
  // Loading validates app.getVersion(); defer until packaged-update guards pass.
  return (require('electron-updater') as { autoUpdater: ElectronAutoUpdater }).autoUpdater
}
