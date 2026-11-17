// Orca Cloud's members of the preload `runtimeEnvironments` bridge, spread into it.
import { ipcRenderer } from 'electron'
import type {
  RuntimePortForward,
  RuntimePortForwardOpenRequest,
  RuntimePortForwardOpenResult
} from '../../../shared/runtime-port-forwards'
import { RUNTIME_PORT_FORWARDS_CHANGED_CHANNEL } from '../../../shared/runtime-port-forward-channels'
import { CLOUD_MCP_SYNC_CHANGED_CHANNEL } from '../../../shared/agent-mcp-sync/mcp-sync-preferences'
import type {
  AuthCallbackForwardRequest,
  AuthCallbackForwardResult,
  LoopbackCallbackForwardRequest
} from '../../../shared/auth-callback-forward'
import type { McpSyncStatus } from '../../../shared/agent-mcp-sync/mcp-sync-contract'
import type { CloudMcpSyncPreferences } from '../../../shared/agent-mcp-sync/mcp-sync-preferences'
import {
  CLOUD_AGENT_CONFIG_SYNC_CHANGED_CHANNEL,
  CLOUD_AGENT_CONFIG_SYNC_PREFERENCES_CHANNEL,
  type AgentConfigSyncStatus,
  type CloudAgentConfigSyncPreferences
} from '../../../shared/agent-config-sync/agent-config-sync-contract'
import type { RuntimeEnvironmentsCloudApi } from './runtime-environments-cloud-api'

export const runtimeEnvironmentsCloudApi = {
  openAuthCallbackForward: (
    request: AuthCallbackForwardRequest
  ): Promise<AuthCallbackForwardResult> =>
    ipcRenderer.invoke('runtimeEnvironments:openAuthCallbackForward', request),
  closeAuthCallbackForward: (
    request: Pick<AuthCallbackForwardRequest, 'environmentId' | 'flowId'>
  ): Promise<void> => ipcRenderer.invoke('runtimeEnvironments:closeAuthCallbackForward', request),
  listPortForwards: (): Promise<RuntimePortForward[]> =>
    ipcRenderer.invoke('runtimePortForwards:list'),
  openPortForward: (
    request: RuntimePortForwardOpenRequest
  ): Promise<RuntimePortForwardOpenResult> =>
    ipcRenderer.invoke('runtimePortForwards:open', request),
  closePortForward: (request: { id: string }): Promise<RuntimePortForward | null> =>
    ipcRenderer.invoke('runtimePortForwards:close', request),
  wakePortForwardHost: (request: { environmentId: string }): Promise<boolean> =>
    ipcRenderer.invoke('runtimePortForwards:wake', request),
  onPortForwardsChanged: (callback: (forwards: RuntimePortForward[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, forwards: RuntimePortForward[]): void =>
      callback(forwards)
    ipcRenderer.on(RUNTIME_PORT_FORWARDS_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(RUNTIME_PORT_FORWARDS_CHANGED_CHANNEL, listener)
  },
  openLoopbackCallbackForward: (
    request: LoopbackCallbackForwardRequest
  ): Promise<AuthCallbackForwardResult> =>
    ipcRenderer.invoke('runtimeEnvironments:openLoopbackCallbackForward', request),
  getMcpSyncStatus: (environmentId: string): Promise<McpSyncStatus | null> =>
    ipcRenderer.invoke('cloudMcpSync:getStatus', environmentId),
  syncMcpServersNow: (environmentId: string): Promise<McpSyncStatus | null> =>
    ipcRenderer.invoke('cloudMcpSync:syncNow', environmentId),
  getMcpSyncPreferences: (): Promise<CloudMcpSyncPreferences | null> =>
    ipcRenderer.invoke('cloudMcpSync:getPreferences'),
  setMcpSyncPreferences: (
    preferences: Partial<CloudMcpSyncPreferences>
  ): Promise<CloudMcpSyncPreferences | null> =>
    ipcRenderer.invoke('cloudMcpSync:setPreferences', preferences),
  setMcpServerIncluded: (key: string, included: boolean): Promise<CloudMcpSyncPreferences | null> =>
    ipcRenderer.invoke('cloudMcpSync:setServerIncluded', key, included),
  onMcpSyncChanged: (callback: (status: McpSyncStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: McpSyncStatus): void =>
      callback(status)
    ipcRenderer.on(CLOUD_MCP_SYNC_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(CLOUD_MCP_SYNC_CHANGED_CHANNEL, listener)
  },
  getAgentConfigSyncStatus: (environmentId: string): Promise<AgentConfigSyncStatus | null> =>
    ipcRenderer.invoke('cloudAgentConfigSync:getStatus', environmentId),
  syncAgentConfigNow: (environmentId: string): Promise<AgentConfigSyncStatus | null> =>
    ipcRenderer.invoke('cloudAgentConfigSync:syncNow', environmentId),
  getAgentConfigSyncPreferences: (): Promise<CloudAgentConfigSyncPreferences | null> =>
    ipcRenderer.invoke('cloudAgentConfigSync:getPreferences'),
  setAgentConfigSyncPreferences: (
    preferences: Partial<Omit<CloudAgentConfigSyncPreferences, 'excluded'>>
  ): Promise<CloudAgentConfigSyncPreferences | null> =>
    ipcRenderer.invoke('cloudAgentConfigSync:setPreferences', preferences),
  setAgentConfigItemIncluded: (
    key: string,
    included: boolean
  ): Promise<CloudAgentConfigSyncPreferences | null> =>
    ipcRenderer.invoke('cloudAgentConfigSync:setItemIncluded', key, included),
  onAgentConfigSyncChanged: (callback: (status: AgentConfigSyncStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: AgentConfigSyncStatus): void =>
      callback(status)
    ipcRenderer.on(CLOUD_AGENT_CONFIG_SYNC_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(CLOUD_AGENT_CONFIG_SYNC_CHANGED_CHANNEL, listener)
  },
  onAgentConfigSyncPreferencesChanged: (
    callback: (preferences: CloudAgentConfigSyncPreferences) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      preferences: CloudAgentConfigSyncPreferences
    ): void => callback(preferences)
    ipcRenderer.on(CLOUD_AGENT_CONFIG_SYNC_PREFERENCES_CHANNEL, listener)
    return () => ipcRenderer.removeListener(CLOUD_AGENT_CONFIG_SYNC_PREFERENCES_CHANNEL, listener)
  }
} satisfies RuntimeEnvironmentsCloudApi
