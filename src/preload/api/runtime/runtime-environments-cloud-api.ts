// Orca Cloud's members of the preload `runtimeEnvironments` API (loopback auth-callback and port
// forwards, MCP and agent-config sync). All optional: the web client has none of them.
import type {
  RuntimePortForward,
  RuntimePortForwardOpenRequest,
  RuntimePortForwardOpenResult
} from '../../../shared/runtime-port-forwards'
import type {
  AuthCallbackForwardRequest,
  AuthCallbackForwardResult,
  LoopbackCallbackForwardRequest
} from '../../../shared/auth-callback-forward'
import type { McpSyncStatus } from '../../../shared/agent-mcp-sync/mcp-sync-contract'
import type { CloudMcpSyncPreferences } from '../../../shared/agent-mcp-sync/mcp-sync-preferences'
import type {
  AgentConfigSyncStatus,
  CloudAgentConfigSyncPreferences
} from '../../../shared/agent-config-sync/agent-config-sync-contract'

export type RuntimeEnvironmentsCloudApi = {
  // Absent in the web client, which cannot listen on this computer's loopback.
  openAuthCallbackForward?: (
    request: AuthCallbackForwardRequest
  ) => Promise<AuthCallbackForwardResult>
  closeAuthCallbackForward?: (
    request: Pick<AuthCallbackForwardRequest, 'environmentId' | 'flowId'>
  ) => Promise<void>
  // Absent in the web client, which cannot listen on this computer's loopback.
  listPortForwards?: () => Promise<RuntimePortForward[]>
  openPortForward?: (
    request: RuntimePortForwardOpenRequest
  ) => Promise<RuntimePortForwardOpenResult>
  closePortForward?: (request: { id: string }) => Promise<RuntimePortForward | null>
  wakePortForwardHost?: (request: { environmentId: string }) => Promise<boolean>
  onPortForwardsChanged?: (callback: (forwards: RuntimePortForward[]) => void) => () => void
  // An agent's own OAuth callback on the host (e.g. an MCP server sign-in); desktop only.
  openLoopbackCallbackForward?: (
    request: LoopbackCallbackForwardRequest
  ) => Promise<AuthCallbackForwardResult>
  // Orca Cloud MCP sync; absent in the web client, which has no local agent configs.
  getMcpSyncStatus?: (environmentId: string) => Promise<McpSyncStatus | null>
  syncMcpServersNow?: (environmentId: string) => Promise<McpSyncStatus | null>
  getMcpSyncPreferences?: () => Promise<CloudMcpSyncPreferences | null>
  setMcpSyncPreferences?: (
    preferences: Partial<CloudMcpSyncPreferences>
  ) => Promise<CloudMcpSyncPreferences | null>
  setMcpServerIncluded?: (key: string, included: boolean) => Promise<CloudMcpSyncPreferences | null>
  onMcpSyncChanged?: (callback: (status: McpSyncStatus) => void) => () => void
  // Orca Cloud skills and slash commands sync; desktop only, like MCP sync.
  getAgentConfigSyncStatus?: (environmentId: string) => Promise<AgentConfigSyncStatus | null>
  syncAgentConfigNow?: (environmentId: string) => Promise<AgentConfigSyncStatus | null>
  getAgentConfigSyncPreferences?: () => Promise<CloudAgentConfigSyncPreferences | null>
  setAgentConfigSyncPreferences?: (
    preferences: Partial<Omit<CloudAgentConfigSyncPreferences, 'excluded'>>
  ) => Promise<CloudAgentConfigSyncPreferences | null>
  setAgentConfigItemIncluded?: (
    key: string,
    included: boolean
  ) => Promise<CloudAgentConfigSyncPreferences | null>
  onAgentConfigSyncChanged?: (callback: (status: AgentConfigSyncStatus) => void) => () => void
  onAgentConfigSyncPreferencesChanged?: (
    callback: (preferences: CloudAgentConfigSyncPreferences) => void
  ) => () => void
}
