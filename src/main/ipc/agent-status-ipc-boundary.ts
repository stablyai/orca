import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export type AgentStatusRuntimeEnrichment = Pick<
  OrcaRuntimeService,
  'getAgentStatusTerminalHandleForPaneKey' | 'getAgentStatusOrchestrationContextForPaneKey'
>

const MAX_AGENT_STATUS_DROP_TAB_ID_LENGTH = 160

export function enrichAgentStatusIpcPayload(
  data: AgentStatusIpcPayload,
  runtime: AgentStatusRuntimeEnrichment | undefined
): AgentStatusIpcPayload {
  if (!runtime) {
    return data
  }
  const terminalHandle = runtime.getAgentStatusTerminalHandleForPaneKey(data.paneKey)
  const orchestration = runtime.getAgentStatusOrchestrationContextForPaneKey(data.paneKey)
  return {
    ...data,
    ...(terminalHandle ? { terminalHandle } : {}),
    ...(orchestration ? { orchestration } : {})
  }
}

export function isValidAgentStatusDropTabId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_AGENT_STATUS_DROP_TAB_ID_LENGTH &&
    value.trim() === value &&
    isValidTerminalTabId(value)
  )
}
