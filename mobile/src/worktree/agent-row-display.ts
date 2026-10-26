import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { AgentTurnOutcome } from '../../../src/shared/agent-turn-outcome'
import { isAgentStatusFresh } from '../../../src/shared/agent-status-freshness'

// Mirror desktop AgentStateDot vocabulary.
export type AgentDotState =
  | 'working'
  | 'monitoring'
  | 'blocked'
  | 'waiting'
  | 'done'
  | 'idle'
  | 'interrupted'
  | 'failed'
  | 'unconfirmed'

// A session tab's AgentStatusEntry leaves `interrupted` optional; worktree rows always send it.
type AgentRowVerdictSource = Pick<RuntimeWorktreeAgentRow, 'state' | 'mainAgent'> & {
  interrupted?: boolean
}

// Mirror AGENT_TURN_OUTCOMES; unparsed future host arms yield no verdict.
const AGENT_TURN_OUTCOMES: readonly AgentTurnOutcome[] = [
  'success',
  'failure',
  'cancellation',
  'superseded',
  'interruption',
  'unconfirmed'
]

// Mirror desktop verdict accessors; mainAgent remains distinct while subagents keep the row working.
export function agentRowVerdict(row: AgentRowVerdictSource): AgentTurnOutcome | null {
  if (row.mainAgent && row.mainAgent.state !== 'done') {
    return null
  }
  const outcome = row.mainAgent?.outcome
  if (outcome !== undefined) {
    return AGENT_TURN_OUTCOMES.find((known) => known === outcome) ?? null
  }
  return row.state === 'done' && row.interrupted ? 'cancellation' : null
}

// Faults outrank live state; Stop, superseded and unproven endings mark only rows already done.
export function agentRowVerdictMark(
  row: AgentRowVerdictSource
): 'failed' | 'interrupted' | 'unconfirmed' | null {
  switch (agentRowVerdict(row)) {
    case 'failure':
    case 'interruption':
      return 'failed'
    case 'cancellation':
    case 'superseded':
      return row.state === 'done' ? 'interrupted' : null
    case 'unconfirmed':
      return row.state === 'done' ? 'unconfirmed' : null
    case 'success':
    case null:
      return null
  }
}

export function agentDotState(
  row: AgentRowVerdictSource &
    Pick<RuntimeWorktreeAgentRow, 'workingMode'> &
    Parameters<typeof isAgentStatusFresh>[0],
  now: number
): AgentDotState {
  const mark = agentRowVerdictMark(row)
  if (mark) {
    return mark
  }
  switch (row.state) {
    case 'blocked':
    case 'waiting':
      // Decay stale active states like desktop so agents exiting without a report cannot remain active forever.
      return isAgentStatusFresh(row, now) ? row.state : 'idle'
    case 'working':
      if (!isAgentStatusFresh(row, now)) {
        return 'idle'
      }
      return row.workingMode === 'monitoring' ? 'monitoring' : 'working'
    case 'done':
      return 'done'
  }
  return 'idle'
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

export function agentIdentityLabel(agentType: string | null): string {
  if (!agentType) {
    return ''
  }
  const normalized = agentType.toLowerCase()
  const known: Record<string, string> = {
    claude: 'CL',
    codex: 'CX',
    gemini: 'GM',
    cursor: 'CR',
    copilot: 'CP',
    amp: 'AM',
    aider: 'AI',
    opencode: 'OC',
    'mimo-code': 'MC'
  }
  return known[normalized] ?? normalized.slice(0, 2).toUpperCase()
}

// Mirror desktop lastEnteredDoneAt: date main-agent failures independently while subagents remain active.
export function agentRowTimeAt(
  row: Pick<RuntimeWorktreeAgentRow, 'state' | 'interrupted' | 'mainAgent' | 'stateStartedAt'>
): number {
  if (row.state !== 'done' && row.mainAgent && agentRowVerdictMark(row) === 'failed') {
    return row.mainAgent.stateStartedAt
  }
  return row.stateStartedAt
}

export function formatTimeAgo(ts: number, now: number): string {
  const delta = now - ts
  if (delta < 60_000) {
    return 'just now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  const days = Math.floor(hours / 24)
  return `${days}d`
}
