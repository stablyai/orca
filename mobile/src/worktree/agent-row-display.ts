import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { AgentJournalTurnOutcome } from '../../../src/shared/agent-turn-outcome'

// Mirrors the desktop AGENT_STATUS_STALE_AFTER_MS (src/shared/agent-status-types.ts:
// 30 min). Defined locally rather than imported because a runtime-value import
// from a root .ts breaks mobile's vitest transform (no tsconfig in the
// mobile-only checkout); root type-only imports stay fine.
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000

// Mirrors the desktop AgentStateDot vocabulary. The wire `state` is the agent
// status state; 'blocked'/'waiting' read as attention states, 'done' as
// complete, everything else idle.
export type AgentDotState =
  | 'working'
  | 'monitoring'
  | 'blocked'
  | 'waiting'
  | 'done'
  | 'idle'
  | 'interrupted'
  | 'failed'

type AgentRowVerdictSource = Pick<RuntimeWorktreeAgentRow, 'state' | 'interrupted' | 'mainAgent'>

// Mirrors desktop agentMainAgentVerdict and agentVerdictDisplayMark
// (src/shared/agent-main-agent-verdict.ts); a parity test runs both over one table. `mainAgent` is
// the main agent's own status, sent also while subagents hold the row working; an old host sends none.
export function agentRowVerdict(row: AgentRowVerdictSource): AgentJournalTurnOutcome | null {
  if (row.mainAgent && row.mainAgent.state !== 'done') {
    return null
  }
  return row.mainAgent?.outcome ?? (row.state === 'done' && row.interrupted ? 'cancellation' : null)
}

// A failure outranks every state; a stop marks only a row that is itself done.
export function agentRowVerdictMark(row: AgentRowVerdictSource): 'failed' | 'interrupted' | null {
  const verdict = agentRowVerdict(row)
  if (verdict === 'failure') {
    return 'failed'
  }
  return verdict === 'cancellation' && row.state === 'done' ? 'interrupted' : null
}

export function agentDotState(
  row: Pick<
    RuntimeWorktreeAgentRow,
    'state' | 'workingMode' | 'interrupted' | 'mainAgent' | 'updatedAt'
  >,
  now: number
): AgentDotState {
  const mark = agentRowVerdictMark(row)
  if (mark) {
    return mark
  }
  switch (row.state) {
    case 'blocked':
    case 'waiting':
      // Why: an agent that exits without a final report would otherwise read as
      // active forever. Decay a stale active state to idle, matching desktop's
      // renderer-side staleness decay (worktree-agent-rows.ts).
      return now - row.updatedAt > AGENT_STATUS_STALE_AFTER_MS ? 'idle' : row.state
    case 'working':
      if (now - row.updatedAt > AGENT_STATUS_STALE_AFTER_MS) {
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
    case 'done':
      return 'Done'
    case 'idle':
      return 'Idle'
  }
}

// Primary row text: prefer the agent's last message, then the user prompt, then
// a human-readable state label so a row is never blank. Matches the desktop
// DashboardAgentRow displayLabel fallback chain.
export function agentDisplayLabel(row: RuntimeWorktreeAgentRow, now: number): string {
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

// Short agent identity label by type (Claude/Codex/Gemini/…), used when no
// identity icon is available on mobile. Falls back to the first two letters.
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

// When the row's state began, except that a main agent that failed while its subagents run is
// dated by its own failure. Mirrors desktop lastEnteredDoneAt (agent-finished-timestamp.ts).
export function agentRowTimeAt(
  row: Pick<RuntimeWorktreeAgentRow, 'state' | 'interrupted' | 'mainAgent' | 'stateStartedAt'>
): number {
  if (row.state !== 'done' && row.mainAgent && agentRowVerdictMark(row) === 'failed') {
    return row.mainAgent.stateStartedAt
  }
  return row.stateStartedAt
}

// Relative time, matching desktop formatTimeAgo thresholds (just now / Xm / Xh / Xd).
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
