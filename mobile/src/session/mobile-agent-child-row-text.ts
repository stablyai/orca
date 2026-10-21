// The phone's words for one child row: the shared row model decides what it says (name, detail,
// lead order); this only puts each detail kind into English, as desktop's agent rows phrase it.

import {
  agentChildRowLeadTrail,
  agentChildRowName
} from '../../../src/shared/agent-child-row-lead-trail'
import type { AgentChildRowModel } from '../../../src/shared/agent-child-row-model'
import type { AgentChildDisplayState } from '../../../src/shared/agent-status-child-work-display'
import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import { sayBackgroundTaskEnglish } from '../../../src/shared/background-task-copy'
import {
  backgroundTaskStateReason,
  backgroundTaskStateWord
} from '../../../src/shared/background-task-roster'
import { agentStateLabel } from '../worktree/agent-row-display'

// Mobile's agent-row words for every state they cover; only child rows reach `unverifiable`.
export function mobileAgentChildStateLabel(state: AgentChildDisplayState): string {
  return state === 'unverifiable' ? 'No recent update' : agentStateLabel(state)
}

/** Coarse `34m` / `2h` / `3d`, floored so it never overstates the gap (desktop's no-update form). */
function compactDuration(deltaMs: number): string {
  const minutes = Math.max(0, Math.floor(deltaMs / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

function detailText(row: AgentChildRowModel, now: number): string {
  const detail = row.detail
  if (!detail) {
    return ''
  }
  switch (detail.kind) {
    case 'operation': {
      const toolName = detail.toolName.trim()
      const input = detail.input?.trim() ?? ''
      return toolName && input ? `${toolName}: ${input}` : toolName
    }
    case 'monitoring':
      return mobileAgentChildStateLabel('monitoring')
    case 'message':
      return detail.text
    case 'ended':
      return 'Ended'
    case 'no-update':
      return `No update in ${compactDuration(now - row.recencyAt)}`
    case 'role':
      return formatAgentTypeLabel(detail.agentType)
    case 'reason':
      return (
        backgroundTaskStateReason(detail.state, sayBackgroundTaskEnglish) ??
        backgroundTaskStateWord(detail.state, sayBackgroundTaskEnglish)
      )
  }
}

export function mobileAgentChildRowName(row: AgentChildRowModel): string {
  return agentChildRowName(row, mobileAgentChildStateLabel)
}

export function mobileAgentChildRowText(
  row: AgentChildRowModel,
  now: number
): { lead: string; trail: string } {
  return agentChildRowLeadTrail(row, mobileAgentChildRowName(row), detailText(row, now))
}
