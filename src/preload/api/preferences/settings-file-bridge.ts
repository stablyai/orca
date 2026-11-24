import { ipcRenderer } from 'electron'
import type { SettingsFileStatus } from '../../../shared/settings/settings-file/settings-file-status-types'
import type { PreloadApi } from '../../api-types'

export const settingsFileApi = {
  getStatus: (): Promise<SettingsFileStatus> => ipcRenderer.invoke('settings-file:get-status'),
  create: (): Promise<SettingsFileStatus> => ipcRenderer.invoke('settings-file:create'),
  open: (): Promise<string> => ipcRenderer.invoke('settings-file:open'),
  onStatusChanged: (callback: (status: SettingsFileStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: SettingsFileStatus): void =>
      callback(status)
    ipcRenderer.on('settings-file:status-changed', listener)
    return () => ipcRenderer.removeListener('settings-file:status-changed', listener)
  }
} satisfies PreloadApi['settingsFile']
