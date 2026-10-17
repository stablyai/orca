import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { CopilotStatus } from '../../shared/copilot-inline-completion-types'

export const copilotCompletionApi = {
  openDocument: (args) => ipcRenderer.invoke('copilotCompletion:openDocument', args),
  changeDocument: (args) => ipcRenderer.invoke('copilotCompletion:changeDocument', args),
  closeDocument: (args) => ipcRenderer.invoke('copilotCompletion:closeDocument', args),
  inlineCompletion: (args) => ipcRenderer.invoke('copilotCompletion:inlineCompletion', args),
  status: () => ipcRenderer.invoke('copilotCompletion:status'),
  signIn: () => ipcRenderer.invoke('copilotCompletion:signIn'),
  onStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: CopilotStatus): void =>
      callback(status)
    ipcRenderer.on('copilotCompletion:status', listener)
    return () => ipcRenderer.removeListener('copilotCompletion:status', listener)
  }
} satisfies PreloadApi['copilotCompletion']
