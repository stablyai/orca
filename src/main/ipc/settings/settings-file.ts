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
    if (!sync) {
      throw new Error('Settings file sync is unavailable.')
    }
    return await sync.createFromCurrentSettings()
  })

  ipcMain.handle('settings-file:open', async () => {
    const { path } = sync?.getStatus() ?? disabledStatus()
    try {
      await access(path)
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') {
        return ''
      }
      return error instanceof Error ? error.message : String(error)
    }
    return await shell.openPath(path)
  })
}
