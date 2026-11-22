import type { RuntimeWorktreeAgentRow } from '../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import { isAgentStatusFresh } from '../../../../src/shared/agent-status/contracts/agent-status-freshness'
import { agentVerdictDisplayMark } from '../../../../src/shared/agent-status/lifecycle/agent-main-agent-verdict'
import { resolveDecayedAgentRowState } from '../../../../src/shared/agent-status/presentation/agent-row-decay-state'
import { getAgentRowPrimaryText } from '../../../../src/shared/agent-status/presentation/agent-row-primary-text'
import type { AgentListStatus } from '../../../../src/shared/agent-status/presentation/agent-list-status'
import { translate, type Translate } from '../../i18n/mobile-i18n'

// Desktop AgentStateDot's vocabulary.
export type AgentDotState = AgentListStatus

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
    case 'permission':
      return translate('worktree.agentRowDisplay.permission', 'Needs attention')
  }
}

/** The row's label when it leads with a forked chat's name: that name and what follows it. */
export function agentDisplayForkedLead(
  row: RuntimeWorktreeAgentRow,
  label: string
): { name: string; rest: string } | null {
  const name = row.conversationName?.trim()
  return row.conversationForked && name && label.startsWith(name)
    ? { name, rest: label.slice(name.length) }
    : null
}

// Match desktop's compact row: name then message, else message → prompt → state; Stop leads while ending the turn.
export function agentDisplayLabel(row: RuntimeWorktreeAgentRow, now: number): string {
  const name = row.conversationName?.trim()
  const message = row.lastAssistantMessage?.trim()
  if (row.state === 'working' && row.mainAgent?.stopping === true) {
    const stopping = translate('worktree.agentRowDisplay.stopping', 'Stopping…')
    return name ? `${stopping} · ${name}` : stopping
  }
  if (name) {
    return message ? `${name} · ${message}` : name
  }
  if (message) {
    return message
  }
  const prompt = getAgentRowPrimaryText({ prompt: row.prompt })
  if (prompt) {
    return prompt
  }
  return agentStateLabel(agentDotState(row, now))
}

// Mirror desktop lastEnteredDoneAt: date main-agent failures independently while subagents remain active.
export function agentRowTimeAt(
  row: AgentRowVerdictSource & Pick<RuntimeWorktreeAgentRow, 'stateStartedAt'>
): number {
  if (row.state !== 'done' && row.mainAgent && agentVerdictDisplayMark(row) === 'failed') {
    return row.mainAgent.stateStartedAt
  }
  return row.stateStartedAt
}

/** "5m", "2h", "3d" in the UI language; the usage widget builds its reset countdown from these too. */
export function formatCompactUnit(
  count: number,
  unit: 'minute' | 'hour' | 'day',
  t: Translate = translate
): string {
  if (unit === 'minute') {
    return count === 1
      ? t('worktree.agentRowDisplay.minutes_one', '{{count}}m', { count })
      : t('worktree.agentRowDisplay.minutes_other', '{{count}}m', { count })
  }
  if (unit === 'hour') {
    return count === 1
      ? t('worktree.agentRowDisplay.hours_one', '{{count}}h', { count })
      : t('worktree.agentRowDisplay.hours_other', '{{count}}h', { count })
  }
  return count === 1
    ? t('worktree.agentRowDisplay.days_one', '{{count}}d', { count })
    : t('worktree.agentRowDisplay.days_other', '{{count}}d', { count })
}

export function formatTimeAgo(ts: number, now: number, t: Translate = translate): string {
  const delta = now - ts
  if (delta < 60_000) {
    return t('worktree.agentRowDisplay.justNow', 'just now')
  }
  const minutes = Math.max(0, Math.floor(delta / 60_000))
  if (minutes < 60) {
    return formatCompactUnit(minutes, 'minute', t)
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return formatCompactUnit(hours, 'hour', t)
  }
  return formatCompactUnit(Math.floor(hours / 24), 'day', t)
}
