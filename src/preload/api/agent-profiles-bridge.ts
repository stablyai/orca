import { ipcRenderer } from 'electron'
import type { AgentProfilesApi } from '../../shared/agent-profile-connection'
export const agentProfilesApi: AgentProfilesApi = {
  preview: (input) => ipcRenderer.invoke('agentProfiles:preview', input),
  save: (input) => ipcRenderer.invoke('agentProfiles:save', input),
  unlink: (id) => ipcRenderer.invoke('agentProfiles:unlink', id)
}
