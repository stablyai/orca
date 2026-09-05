import { ipcRenderer } from 'electron'
import type {
  AgentThroughputClearIpcPayload,
  AgentThroughputSample
} from '../../shared/agent-throughput-types'
import type { AgentThroughputApi } from './agent-throughput-api'

export const agentThroughputApi: AgentThroughputApi = {
  onSet: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, data: AgentThroughputSample) =>
      callback(data)
    ipcRenderer.on('agentThroughput:set', listener)
    return () => ipcRenderer.removeListener('agentThroughput:set', listener)
  },
  onClear: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, data: AgentThroughputClearIpcPayload) =>
      callback(data)
    ipcRenderer.on('agentThroughput:clear', listener)
    return () => ipcRenderer.removeListener('agentThroughput:clear', listener)
  },
  getSnapshot: () => ipcRenderer.invoke('agentThroughput:getSnapshot')
}
