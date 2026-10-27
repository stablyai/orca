import {
  agentChildRowDetailText,
  agentChildRowLeadTrail,
  agentChildRowName
} from '../../../src/shared/agent-child-row-lead-trail'
import type { AgentChildRowModel } from '../../../src/shared/agent-child-row-model'
import type { AgentChildDisplayState } from '../../../src/shared/agent-status-child-work-display'
import { sayBackgroundTaskEnglish } from '../../../src/shared/background-task-copy'
import { agentStateLabel } from '../worktree/agent-row-display'

export function mobileAgentChildStateLabel(state: AgentChildDisplayState): string {
  return state === 'unverifiable' ? 'No recent update' : agentStateLabel(state)
}

const MOBILE_AGENT_CHILD_ROW_COPY = {
  stateLabel: mobileAgentChildStateLabel,
  ended: () => 'Ended',
  sayBackgroundTask: sayBackgroundTaskEnglish
}

export function mobileAgentChildRowName(row: AgentChildRowModel): string {
  return agentChildRowName(row, mobileAgentChildStateLabel)
}

export function mobileAgentChildRowText(
  row: AgentChildRowModel,
  now: number
): { lead: string; trail: string } {
  return agentChildRowLeadTrail(
    row,
    mobileAgentChildRowName(row),
    agentChildRowDetailText(row, now, MOBILE_AGENT_CHILD_ROW_COPY)
  )
}
