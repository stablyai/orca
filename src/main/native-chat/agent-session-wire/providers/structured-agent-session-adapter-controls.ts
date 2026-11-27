import type { StructuredAgentSessionAdapterPermission } from './structured-agent-session-adapter-permission'
import type { StructuredAgentSessionAdapterStop } from './structured-agent-session-adapter-stop'
import type { AgentHistoryReader } from './structured-agent-session-history-refresh-input'

export type StructuredAgentAdapterControls = StructuredAgentSessionAdapterStop &
  StructuredAgentSessionAdapterPermission &
  AgentHistoryReader
