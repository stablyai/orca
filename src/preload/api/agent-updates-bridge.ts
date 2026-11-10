import { ipcRenderer } from 'electron'
import type { AgentUpdatesState } from '../../shared/agent-updates/agent-update-types'
import type { AgentUpdatesApi } from './agent-updates-api'

export const agentUpdatesApi: AgentUpdatesApi = {
  getState: () => ipcRenderer.invoke('agentUpdates:getState'),
  refresh: () => ipcRenderer.invoke('agentUpdates:refresh'),
  update: (request) => ipcRenderer.invoke('agentUpdates:update', request),
  onState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AgentUpdatesState) =>
      callback(state)
    ipcRenderer.on('agentUpdates:state', listener)
    return () => ipcRenderer.removeListener('agentUpdates:state', listener)
  }
}
