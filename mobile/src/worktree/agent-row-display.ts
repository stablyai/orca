import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { resolveAgentRowDisplayState } from '../../../src/shared/agent-status-row-display'

export { AGENT_STATUS_STALE_AFTER_MS } from '../../../src/shared/agent-status-freshness'

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

/**
 * The dot this row shows. The staleness decay is the shared one
 * (src/shared/agent-status-row-display.ts) so the phone and the desktop agree on when an
 * agent that stopped reporting stops reading as active; only the dot vocabulary is local.
 *
 * `worktree ps` rows carry no live-PTY evidence, so `hasLivePty` stays unset and a decayed
 * row lands on `idle` — the desktop's `unverifiable` claims liveness this reader cannot see.
 */
export function agentDotState(
  row: Pick<
    RuntimeWorktreeAgentRow,
    | 'state'
    | 'workingMode'
    | 'interrupted'
    | 'updatedAt'
    | 'restoredUnconfirmed'
    | 'structuredHostOwned'
  >,
  now: number
): AgentDotState {
  if (row.interrupted) {
    return 'interrupted'
  }
  const displayState = resolveAgentRowDisplayState(row, now)
  switch (displayState) {
    case 'working':
      return row.workingMode === 'monitoring' ? 'monitoring' : 'working'
    case 'blocked':
    case 'waiting':
    case 'done':
      return displayState
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
