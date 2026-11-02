import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { DashboardCardTerminalInput } from '../../shared/dashboard-snapshot'

export const detachedTerminalApi = {
  open: (args) => ipcRenderer.invoke('detachedTerminal:open', args),
  close: (tabId) => ipcRenderer.invoke('detachedTerminal:close', { tabId }),
  returnToMain: (tabId) => ipcRenderer.invoke('detachedTerminal:returnToMain', { tabId }),
  onClosed: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { tabId: string }): void =>
      callback(payload.tabId)
    ipcRenderer.on('detachedTerminal:closed', listener)
    return () => ipcRenderer.removeListener('detachedTerminal:closed', listener)
  },
  setTerminalInput: (tabId, terminalInput) =>
    ipcRenderer.invoke('detachedTerminal:setTerminalInput', { tabId, terminalInput }),
  getTerminalInput: (tabId) => ipcRenderer.invoke('detachedTerminal:getTerminalInput', { tabId }),
  onTerminalInput: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      terminalInput: DashboardCardTerminalInput | null
    ): void => callback(terminalInput)
    ipcRenderer.on('detachedTerminal:terminalInput', listener)
    return () => ipcRenderer.removeListener('detachedTerminal:terminalInput', listener)
  }
} satisfies PreloadApi['detachedTerminal']
