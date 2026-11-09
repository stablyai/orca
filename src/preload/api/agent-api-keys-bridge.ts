import { ipcRenderer } from 'electron'
import type {
  AgentApiKeySaveRequest,
  AgentApiKeysMutationResult,
  AgentApiKeysState
} from '../../shared/agent-api-keys/agent-api-key-catalog'

/** Desktop only. Values go in; nothing comes back but names, scopes and hints. */
export type AgentApiKeysApi = {
  list: () => Promise<AgentApiKeysState>
  save: (request: AgentApiKeySaveRequest) => Promise<AgentApiKeysMutationResult>
  remove: (id: string) => Promise<AgentApiKeysMutationResult>
}

export const agentApiKeysApi: AgentApiKeysApi = {
  list: () => ipcRenderer.invoke('agentApiKeys:list'),
  save: (request) => ipcRenderer.invoke('agentApiKeys:save', request),
  remove: (id) => ipcRenderer.invoke('agentApiKeys:remove', id)
}
