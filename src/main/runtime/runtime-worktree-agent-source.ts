import type { StructuredHostStatus } from '../../shared/agent-hook-listener/listener-event'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import type { AgentMainAgentStatus } from '../../shared/main-agent-status'
import type { RuntimeTerminalInteractiveWait } from '../../shared/runtime-types'

export type RuntimeWorktreeAgentSource = {
  paneKey: string
  ptyId?: string
  /** The issued terminal handle the status row was observed under; the key the ps assembly
   *  resolves the richer wait signal through. */
  terminalHandle?: string
  tabId?: string
  worktreeId?: string
  connectionId: string | null
  state: ParsedAgentStatusPayload['state']
  workingMode?: ParsedAgentStatusPayload['workingMode']
  agentType: string | null
  prompt: string
  lastAssistantMessage: string | null
  toolName: string | null
  toolInput: string | null
  interrupted: boolean
  mainAgent?: AgentMainAgentStatus
  stateStartedAt: number
  updatedAt: number
  /** Resolved from `terminalHandle` by the ps assembly; see `RuntimeWorktreeAgentRow.agentWait`. */
  agentWait?: RuntimeTerminalInteractiveWait | null
  /** Projected by the structured session host; `owned` rows stay fresh past the staleness window. */
  structuredHost?: StructuredHostStatus
}
