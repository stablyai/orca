import { ipcRenderer } from 'electron'
import type { SharedBotHostsState } from '../../shared/bots/shared-bot-hosts'
import type { PreloadApi } from '../api-types'

export const sharedBotHostsApi = {
  list: () => ipcRenderer.invoke('sharedBotHosts:list'),
  onChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: SharedBotHostsState) =>
      callback(state)
    ipcRenderer.on('sharedBotHosts:changed', listener)
    return () => ipcRenderer.removeListener('sharedBotHosts:changed', listener)
  },
  sendAgain: (args) => ipcRenderer.invoke('sharedBotHosts:sendAgain', args)
} satisfies PreloadApi['sharedBotHosts']
