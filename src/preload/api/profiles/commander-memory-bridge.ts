import { ipcRenderer } from 'electron'
import type { CommanderMemoryApi } from '../../../shared/commander/memory-contract'

export const commanderMemoryApi: CommanderMemoryApi = {
  index: (account, query) => ipcRenderer.invoke('commanderMemory:index', account, query),
  workerGuidance: (account, projectId) =>
    ipcRenderer.invoke('commanderMemory:workerGuidance', account, projectId),
  recurringAnswers: (account, change) =>
    ipcRenderer.invoke('commanderMemory:recurringAnswers', account, change),
  agentRecovery: (account, enabled) =>
    ipcRenderer.invoke('commanderMemory:agentRecovery', account, enabled),
  phoneSharing: (account, enabled) =>
    ipcRenderer.invoke('commanderMemory:phoneSharing', account, enabled),
  exportAgentGrant: (account, grant) =>
    ipcRenderer.invoke('commanderMemory:exportAgentGrant', account, grant),
  list: (account) => ipcRenderer.invoke('commanderMemory:list', account),
  get: (account, pageId, beforeVersion) =>
    ipcRenderer.invoke('commanderMemory:get', account, pageId, beforeVersion),
  save: (account, write) => ipcRenderer.invoke('commanderMemory:save', account, write),
  checkpoint: (account, write) => ipcRenderer.invoke('commanderMemory:checkpoint', account, write)
}
