import type { StructuredHostStatus } from '../../shared/agent-hook-listener/listener-event'
import type {
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import type { AgentChildWorkView } from '../../shared/agent-status-child-work-view'
import type { AgentMainAgentStatus } from '../../shared/main-agent-status'
import type { ProgramStatusFacet } from '../../shared/program-status/facet'

export type RuntimeWorktreeAgentSource = Pick<AgentStatusIpcPayload, 'subagents'> & {
  children?: AgentChildWorkView[]
  paneKey: string
  ptyId?: string
  /** Issued handle the hook row was observed under; keys the agentWait lookup. */
  terminalHandle?: string
  tabId?: string
  /** A connected PTY on this host backs the row. */
  hasLivePty?: true
  worktreeId?: string
  connectionId: string | null
  state: ParsedAgentStatusPayload['state']
  workingMode?: ParsedAgentStatusPayload['workingMode']
  agentType: string | null
  /** Names the provider session whose saved title the row may wear. */
  providerSessionId?: string
  prompt: string
  lastAssistantMessage: string | null
  toolName: string | null
  toolInput: string | null
  interrupted: boolean
  mainAgent?: AgentMainAgentStatus
  stateStartedAt: number
  updatedAt: number
  /** Projected by the structured session host; `owned` rows stay fresh past the staleness window. */
  structuredHost?: StructuredHostStatus
  programStatus?: ProgramStatusFacet
}
