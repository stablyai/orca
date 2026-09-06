import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const sparsePresetsApi = {
  list: (args) => ipcRenderer.invoke('sparsePresets:list', args),

  save: (args) => ipcRenderer.invoke('sparsePresets:save', args),

  remove: (args) => ipcRenderer.invoke('sparsePresets:remove', args),

  onChanged: (callback: (data: { repoId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { repoId: string }) => callback(data)
    ipcRenderer.on('sparsePresets:changed', listener)
    return () => ipcRenderer.removeListener('sparsePresets:changed', listener)
  }
} satisfies PreloadApi['sparsePresets']
