import type { StructuredHostStatus } from '../../shared/agent-hook-listener/listener-event'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import type { AgentStatusLaunchMembership } from '../../shared/agent-status-launch-membership'

export type RuntimeWorktreeAgentSource = {
  paneKey: string
  ptyId?: string
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
  stateStartedAt: number
  updatedAt: number
  /** Projected by the structured session host; `owned` rows stay fresh past the staleness window. */
  structuredHost?: StructuredHostStatus
  /** Presence proof from the execution host, independent of turn state. */
  launchMembership?: AgentStatusLaunchMembership
}
