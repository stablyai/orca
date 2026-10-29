import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { isAgentStatusFresh } from '../../../src/shared/agent-status-freshness'
import { agentVerdictDisplayMark } from '../../../src/shared/agent-main-agent-verdict'
import { resolveDecayedAgentRowState } from '../../../src/shared/agent-row-decay-state'
import { translate } from '../i18n/mobile-i18n'

// Mirror desktop AgentStateDot vocabulary.
export type AgentDotState =
  | 'working'
  | 'monitoring'
  | 'blocked'
  | 'waiting'
  | 'done'
  | 'idle'
  | 'unverifiable'
  | 'interrupted'
  | 'failed'
  | 'unconfirmed'

// A session tab's AgentStatusEntry leaves `interrupted` optional; worktree rows always send it.
type AgentRowVerdictSource = Pick<RuntimeWorktreeAgentRow, 'state' | 'mainAgent'> & {
  interrupted?: boolean
}

export function agentDotState(
  row: AgentRowVerdictSource &
    Pick<RuntimeWorktreeAgentRow, 'workingMode' | 'hasLivePty'> &
    Parameters<typeof isAgentStatusFresh>[0],
  now: number
): AgentDotState {
  const mark = agentVerdictDisplayMark(row)
  if (mark) {
    return mark
  }
  if (row.state === 'done') {
    return 'done'
  }
  // Decay stale active states like desktop: a live terminal can't prove the agent ended, so it reads unverifiable.
  if (!isAgentStatusFresh(row, now)) {
    return resolveDecayedAgentRowState(row, row.hasLivePty === true)
  }
  if (row.state === 'working') {
    return row.workingMode === 'monitoring' ? 'monitoring' : 'working'
  }
  return row.state === 'blocked' || row.state === 'waiting' ? row.state : 'idle'
}

// Mirrors desktop agentStateLabel.
export function agentStateLabel(state: AgentDotState): string {
  switch (state) {
    case 'working':
      return translate('worktree.agentRowDisplay.working', 'Working')
    case 'monitoring':
      return translate('worktree.agentRowDisplay.monitoring', 'Monitoring background tasks')
    case 'blocked':
      return translate('worktree.agentRowDisplay.blocked', 'Blocked')
    case 'waiting':
      return translate('worktree.agentRowDisplay.waiting', 'Waiting for input')
    case 'interrupted':
      return translate('worktree.agentRowDisplay.interrupted', 'Interrupted')
    case 'failed':
      return translate('worktree.agentRowDisplay.failed', 'Failed')
    case 'unconfirmed':
      return translate('worktree.agentRowDisplay.unconfirmed', 'Couldn’t confirm')
    case 'done':
      return translate('worktree.agentRowDisplay.done', 'Done')
    case 'idle':
      return translate('worktree.agentRowDisplay.idle', 'Idle')
    case 'unverifiable':
      return translate('worktree.agentRowDisplay.unverifiable', 'No recent update')
  }
}

// Match DashboardAgentRow fallback order; a user-requested Stop takes precedence while ending the turn.
export function agentDisplayLabel(row: RuntimeWorktreeAgentRow, now: number): string {
  if (row.state === 'working' && row.mainAgent?.stopping === true) {
    return translate('worktree.agentRowDisplay.stopping', 'Stopping…')
  }
  const message = row.lastAssistantMessage?.trim()
  if (message) {
    return message
  }
  const prompt = row.prompt.trim()
  if (prompt) {
    return prompt
  }
  return agentStateLabel(agentDotState(row, now))
}

// Mirror desktop lastEnteredDoneAt: date main-agent failures independently while subagents remain active.
export function agentRowTimeAt(
  row: Pick<RuntimeWorktreeAgentRow, 'state' | 'interrupted' | 'mainAgent' | 'stateStartedAt'>
): number {
  if (row.state !== 'done' && row.mainAgent && agentVerdictDisplayMark(row) === 'failed') {
    return row.mainAgent.stateStartedAt
  }
  return row.stateStartedAt
}

export function formatTimeAgo(ts: number, now: number): string {
  const delta = now - ts
  if (delta < 60_000) {
    return translate('worktree.agentRowDisplay.justNow', 'just now')
  }
  const minutes = Math.max(0, Math.floor(delta / 60_000))
  if (minutes < 60) {
    const count = minutes
    return count === 1
      ? translate('worktree.agentRowDisplay.minutes_one', '{{count}}m', { count })
      : translate('worktree.agentRowDisplay.minutes_other', '{{count}}m', { count })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const count = hours
    return count === 1
      ? translate('worktree.agentRowDisplay.hours_one', '{{count}}h', { count })
      : translate('worktree.agentRowDisplay.hours_other', '{{count}}h', { count })
  }
  const count = Math.floor(hours / 24)
  return count === 1
    ? translate('worktree.agentRowDisplay.days_one', '{{count}}d', { count })
    : translate('worktree.agentRowDisplay.days_other', '{{count}}d', { count })
}
