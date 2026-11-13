import { ipcRenderer } from 'electron'
import type {
  AgentCredentialsView,
  AgentSource,
  AgentSourcesView,
  OrcaCloudAccountAgent,
  OrcaCloudAgentSetups,
  OrcaCloudAgentsResult,
  OrcaCloudAgentsStatus
} from '../../shared/orca-cloud-agents/orca-cloud-agents-wire'

/** Desktop only. States and codes come back; a credential never does. */
export type OrcaCloudAgentsApi = {
  status: () => Promise<OrcaCloudAgentsResult<OrcaCloudAgentsStatus>>
  setups: () => Promise<OrcaCloudAgentSetups>
  start: (request: { agent: OrcaCloudAccountAgent }) => Promise<OrcaCloudAgentsResult<true>>
  cancel: (request: { agent: OrcaCloudAccountAgent }) => Promise<void>
  reopen: (request: { agent: OrcaCloudAccountAgent }) => Promise<boolean>
  /** The provider page `reopen` would open, without opening it ("Copy link"); null when none. */
  signInLink: (request: { agent: OrcaCloudAccountAgent }) => Promise<string | null>
  usePaste: () => Promise<void>
  /** The code from Claude's sign-in page, typed into the waiting setup; the reply is a code only. */
  submitClaudeCode: (request: { code: string }) => Promise<OrcaCloudAgentsResult<true>>
  /** The pasted value goes to main once; the reply is a code only. */
  pasteClaudeToken: (request: { token: string }) => Promise<OrcaCloudAgentsResult<true>>
  acknowledge: (request: { agent: OrcaCloudAccountAgent }) => Promise<void>
  remove: (request: {
    agent: OrcaCloudAccountAgent
  }) => Promise<OrcaCloudAgentsResult<AgentCredentialsView>>
  setDefaultSource: (request: {
    agent: OrcaCloudAccountAgent
    source: AgentSource
  }) => Promise<OrcaCloudAgentsResult<AgentSourcesView>>
  /** One workspace's Sources; not_found until the sandbox exists. */
  workspaceSources: (request: {
    runtimeEnvironmentId: string
  }) => Promise<OrcaCloudAgentsResult<AgentSourcesView>>
  /** The per-workspace override (S1-b); the reply describes that workspace. */
  setWorkspaceSource: (request: {
    agent: OrcaCloudAccountAgent
    source: AgentSource
    runtimeEnvironmentId: string
  }) => Promise<OrcaCloudAgentsResult<AgentSourcesView>>
  onSetupChanged: (listener: (setups: OrcaCloudAgentSetups) => void) => () => void
}

export const orcaCloudAgentsApi: OrcaCloudAgentsApi = {
  status: () => ipcRenderer.invoke('orcaCloudAgents:status'),
  setups: () => ipcRenderer.invoke('orcaCloudAgents:setups'),
  start: (request) => ipcRenderer.invoke('orcaCloudAgents:start', request),
  cancel: (request) => ipcRenderer.invoke('orcaCloudAgents:cancel', request),
  reopen: (request) => ipcRenderer.invoke('orcaCloudAgents:reopen', request),
  signInLink: (request) => ipcRenderer.invoke('orcaCloudAgents:signInLink', request),
  usePaste: () => ipcRenderer.invoke('orcaCloudAgents:usePaste'),
  submitClaudeCode: (request) => ipcRenderer.invoke('orcaCloudAgents:submitClaudeCode', request),
  pasteClaudeToken: (request) => ipcRenderer.invoke('orcaCloudAgents:pasteClaudeToken', request),
  acknowledge: (request) => ipcRenderer.invoke('orcaCloudAgents:acknowledge', request),
  remove: (request) => ipcRenderer.invoke('orcaCloudAgents:remove', request),
  setDefaultSource: (request) => ipcRenderer.invoke('orcaCloudAgents:setDefaultSource', request),
  workspaceSources: (request) => ipcRenderer.invoke('orcaCloudAgents:workspaceSources', request),
  setWorkspaceSource: (request) =>
    ipcRenderer.invoke('orcaCloudAgents:setWorkspaceSource', request),
  onSetupChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, setups: OrcaCloudAgentSetups): void =>
      listener(setups)
    ipcRenderer.on('orcaCloudAgents:setupChanged', handler)
    return () => ipcRenderer.removeListener('orcaCloudAgents:setupChanged', handler)
  }
}
