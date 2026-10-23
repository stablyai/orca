import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const detachedTerminalApi = {
  open: (args) => ipcRenderer.invoke('detachedTerminal:open', args),
  close: (tabId) => ipcRenderer.invoke('detachedTerminal:close', { tabId }),
  returnToMain: (tabId) => ipcRenderer.invoke('detachedTerminal:returnToMain', { tabId }),
  onClosed: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { tabId: string }): void =>
      callback(payload.tabId)
    ipcRenderer.on('detachedTerminal:closed', listener)
    return () => ipcRenderer.removeListener('detachedTerminal:closed', listener)
  }
} satisfies PreloadApi['detachedTerminal']
