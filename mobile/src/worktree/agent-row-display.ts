import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { isAgentStatusFresh } from '../../../src/shared/agent-status-freshness'
import { agentVerdictDisplayMark } from '../../../src/shared/agent-main-agent-verdict'
import {
  formatCompactDuration,
  resolveDecayedAgentRowState
} from '../../../src/shared/agent-row-decay-state'

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
      return 'Working'
    case 'monitoring':
      return 'Monitoring background tasks'
    case 'blocked':
      return 'Blocked'
    case 'waiting':
      return 'Waiting for input'
    case 'interrupted':
      return 'Interrupted'
    case 'failed':
      return 'Failed'
    case 'unconfirmed':
      return 'Couldn’t confirm'
    case 'done':
      return 'Done'
    case 'idle':
      return 'Idle'
    case 'unverifiable':
      return 'No recent update'
  }
}

// Mirrors NATIVE_CHAT_TURN_STATUS_COPY.stopping.
const STOPPING_LABEL = 'Stopping…'

// Match DashboardAgentRow fallback order; a user-requested Stop takes precedence while ending the turn.
export function agentDisplayLabel(row: RuntimeWorktreeAgentRow, now: number): string {
  if (row.state === 'working' && row.mainAgent?.stopping === true) {
    return STOPPING_LABEL
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
  return delta < 60_000 ? 'just now' : formatCompactDuration(delta)
}
