import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'

// Mirrors the desktop AGENT_STATUS_STALE_AFTER_MS (src/shared/agent-status-types.ts:
// 30 min). Defined locally rather than imported because a runtime-value import
// from a root .ts breaks mobile's vitest transform (no tsconfig in the
// mobile-only checkout); root type-only imports stay fine.
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000

// Mirrors the desktop AgentStateDot vocabulary. The wire `state` is the agent
// status state; 'blocked'/'waiting' read as attention states, 'done' as
// complete, everything else idle.
export type AgentDotState = 'working' | 'blocked' | 'waiting' | 'done' | 'idle' | 'interrupted'

export function agentDotState(
  row: Pick<RuntimeWorktreeAgentRow, 'state' | 'interrupted' | 'updatedAt'>,
  now: number
): AgentDotState {
  if (row.interrupted) {
    return 'interrupted'
  }
  switch (row.state) {
    case 'working':
    case 'blocked':
    case 'waiting':
      // Why: an agent that exits without a final report would otherwise read as
      // active forever. Decay a stale active state to idle, matching desktop's
      // renderer-side staleness decay (worktree-agent-rows.ts).
      return now - row.updatedAt > AGENT_STATUS_STALE_AFTER_MS ? 'idle' : row.state
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
