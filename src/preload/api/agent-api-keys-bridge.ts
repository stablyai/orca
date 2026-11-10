import { ipcRenderer } from 'electron'
import type {
  AgentApiKeySaveRequest,
  AgentApiKeysMutationResult,
  AgentApiKeysState
} from '../../shared/agent-api-keys/agent-api-key-catalog'
import type {
  AgentApiKeyRemoveRequest,
  AgentApiKeysImportResult,
  AgentApiKeysScanResult
} from '../../shared/agent-api-keys/agent-api-key-cloud'

/** Desktop only. Values go in; nothing comes back but names, scopes and hints. */
export type AgentApiKeysApi = {
  list: () => Promise<AgentApiKeysState>
  save: (request: AgentApiKeySaveRequest) => Promise<AgentApiKeysMutationResult>
  /** A bare id keeps any copy in the Orca account. */
  remove: (request: string | AgentApiKeyRemoveRequest) => Promise<AgentApiKeysMutationResult>
  /** Writes a key that is only on this computer to the Orca account. */
  saveToAccount?: (id: string) => Promise<AgentApiKeysMutationResult>
  /** Keys this computer already uses: names, sources and last fours only. */
  scanThisComputer?: () => Promise<AgentApiKeysScanResult>
  importFromThisComputer?: (names: string[]) => Promise<AgentApiKeysImportResult>
}

export const agentApiKeysApi: AgentApiKeysApi = {
  list: () => ipcRenderer.invoke('agentApiKeys:list'),
  save: (request) => ipcRenderer.invoke('agentApiKeys:save', request),
  remove: (request) => ipcRenderer.invoke('agentApiKeys:remove', request),
  saveToAccount: (id) => ipcRenderer.invoke('agentApiKeys:saveToAccount', id),
  scanThisComputer: () => ipcRenderer.invoke('agentApiKeys:scanThisComputer'),
  importFromThisComputer: (names) =>
    ipcRenderer.invoke('agentApiKeys:importFromThisComputer', names)
}
