import { BrowserWindow, ipcMain, shell } from 'electron'
import { access } from 'node:fs/promises'
import type { SettingsFileStatus } from '../../../shared/settings/settings-file/settings-file-status-types'
import { getUserSettingsFilePath } from '../../settings-file/settings-file-path'
import type { SettingsFileSync } from '../../settings-file/settings-file-sync-types'

function broadcastSettingsFileStatus(status: SettingsFileStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('settings-file:status-changed', status)
    }
  }
}

export function registerSettingsFileHandlers(
  sync: SettingsFileSync | null,
  homePath: string
): void {
  const disabledStatus = (): SettingsFileStatus => ({
    state: 'absent',
    path: getUserSettingsFilePath(homePath),
    appliedKeyCount: 0,
    ignored: []
  })

  sync?.onStatusChanged(broadcastSettingsFileStatus)

  ipcMain.handle('settings-file:get-status', () => sync?.getStatus() ?? disabledStatus())

  ipcMain.handle('settings-file:create', async () => {
    return sync ? await sync.createFromCurrentSettings() : disabledStatus()
  })

  ipcMain.handle('settings-file:open', async () => {
    const { path } = sync?.getStatus() ?? disabledStatus()
    const exists = await access(path).then(
      () => true,
      () => false
    )
    return exists ? await shell.openPath(path) : ''
  })
}
