import {
  agentChildRowDetailText,
  agentChildRowLeadTrail,
  agentChildRowName
} from '../../../src/shared/agent-child-row-lead-trail'
import type { AgentChildRowModel } from '../../../src/shared/agent-child-row-model'
import type { AgentChildDisplayState } from '../../../src/shared/agent-status-child-work-display'
import { sayMobileBackgroundTask } from './mobile-background-task-copy'
import { translate } from '../i18n/mobile-i18n'
import { agentStateLabel } from '../worktree/agent-row-display'

export function mobileAgentChildStateLabel(state: AgentChildDisplayState): string {
  return state === 'unverifiable'
    ? translate('session.agentChildRow.noRecentUpdate', 'No recent update')
    : agentStateLabel(state)
}

function mobileAgentChildRowCopy() {
  return {
    stateLabel: mobileAgentChildStateLabel,
    ended: () => translate('session.agentChildRow.ended', 'Ended'),
    sayBackgroundTask: sayMobileBackgroundTask
  }
}

function noUpdateDuration(deltaMs: number): string {
  const minutes = Math.max(0, Math.floor(deltaMs / 60_000))
  if (minutes < 60) {
    const count = minutes
    return count === 1
      ? translate('session.agentChildRow.minutes_one', '{{count}}m', { count })
      : translate('session.agentChildRow.minutes_other', '{{count}}m', { count })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const count = hours
    return count === 1
      ? translate('session.agentChildRow.hours_one', '{{count}}h', { count })
      : translate('session.agentChildRow.hours_other', '{{count}}h', { count })
  }
  const count = Math.floor(hours / 24)
  return count === 1
    ? translate('session.agentChildRow.days_one', '{{count}}d', { count })
    : translate('session.agentChildRow.days_other', '{{count}}d', { count })
}

export function mobileAgentChildRowName(row: AgentChildRowModel): string {
  return agentChildRowName(row, mobileAgentChildStateLabel)
}

export function mobileAgentChildRowText(
  row: AgentChildRowModel,
  now: number
): { lead: string; trail: string } {
  const detail =
    row.detail?.kind === 'no-update'
      ? translate('session.agentChildRow.noUpdate', 'No update in {{value0}}', {
          value0: noUpdateDuration(now - row.recencyAt)
        })
      : row.detail?.kind === 'role' && (!row.detail.agentType || row.detail.agentType === 'unknown')
        ? translate('session.agentChildRow.agent', 'Agent')
        : agentChildRowDetailText(row, now, mobileAgentChildRowCopy())
  return agentChildRowLeadTrail(row, mobileAgentChildRowName(row), detail)
}
