import { ipcRenderer } from 'electron'
import type { SharedBotHostView } from '../../shared/bots/shared-bot-hosts'
import type { RuntimeRpcResponse } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { PreloadApi } from '../api-types'

export const sharedBotHostsApi = {
  list: () => ipcRenderer.invoke('sharedBotHosts:list'),
  onChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, views: SharedBotHostView[]) =>
      callback(views)
    ipcRenderer.on('sharedBotHosts:changed', listener)
    return () => ipcRenderer.removeListener('sharedBotHosts:changed', listener)
  },
  call: (args) => ipcRenderer.invoke('sharedBotHosts:call', args),
  subscribe: async (args, callback) => {
    const subscriptionId = `shared-${crypto.randomUUID()}`
    const channel = `sharedBotHosts:subscription:${subscriptionId}`
    const listener = (_event: Electron.IpcRendererEvent, response: RuntimeRpcResponse<unknown>) =>
      callback(response)
    ipcRenderer.on(channel, listener)
    try {
      await ipcRenderer.invoke('sharedBotHosts:subscribe', { subscriptionId, ...args })
    } catch (error) {
      ipcRenderer.removeListener(channel, listener)
      throw error
    }
    return {
      unsubscribe: () => {
        ipcRenderer.removeListener(channel, listener)
        ipcRenderer.send('sharedBotHosts:unsubscribe', { subscriptionId })
      }
    }
  }
} satisfies PreloadApi['sharedBotHosts']
