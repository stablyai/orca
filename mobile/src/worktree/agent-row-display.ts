import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { isAgentStatusState } from '../../../src/shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../src/shared/agent-status-freshness'
import {
  resolveAgentPaneDisplayState,
  type AgentStatusDisplayState
} from '../../../src/shared/agent-status-display-state'

export { AGENT_STATUS_STALE_AFTER_MS }

// Mirrors the desktop AgentStateDot vocabulary. Mobile has no 'unverifiable' reader verdict.
export type AgentDotState = Exclude<AgentStatusDisplayState, 'unverifiable'>

type AgentDotRow = Pick<
  RuntimeWorktreeAgentRow,
  'state' | 'workingMode' | 'interrupted' | 'mainAgent' | 'updatedAt'
>

export function agentDotState(row: AgentDotRow, now: number): AgentDotState {
  // Why: rows arrive unparsed, so a state arm from a newer host degrades to idle.
  if (!isAgentStatusState(row.state)) {
    return 'idle'
  }
  // Why: an agent that exits without a final report would otherwise read as
  // active forever. Decay stale live evidence to idle, matching desktop's
  // renderer-side staleness decay (worktree-agent-rows.ts).
  const stale = row.state !== 'done' && now - row.updatedAt > AGENT_STATUS_STALE_AFTER_MS
  const state = resolveAgentPaneDisplayState(row, stale ? 'idle' : undefined)
  return state === 'unverifiable' ? 'idle' : state
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
    case 'failed':
      return 'Failed'
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
