import type {
  RuntimeWorktreeAgentContextPressure,
  RuntimeWorktreeAgentRow
} from '../../../src/shared/runtime-types'

// Missing host-resolved pressure stays unknown and renders nothing.

const LEVEL_RANK: Record<RuntimeWorktreeAgentContextPressure['level'], number> = {
  ok: 0,
  warning: 1,
  critical: 2
}

function isMorePressured(
  candidate: RuntimeWorktreeAgentContextPressure,
  current: RuntimeWorktreeAgentContextPressure
): boolean {
  const byLevel = (LEVEL_RANK[candidate.level] ?? 0) - (LEVEL_RANK[current.level] ?? 0)
  return byLevel !== 0 ? byLevel > 0 : candidate.usedPercent > current.usedPercent
}

/** Returns the worst warning or critical pressure across a worktree. */
export function worstAgentContextPressure(
  agents: readonly Pick<RuntimeWorktreeAgentRow, 'contextPressure'>[]
): RuntimeWorktreeAgentContextPressure | null {
  let worst: RuntimeWorktreeAgentContextPressure | null = null
  for (const agent of agents) {
    const pressure = agent.contextPressure
    if (!pressure || pressure.level === 'ok') {
      continue
    }
    if (!worst || isMorePressured(pressure, worst)) {
      worst = pressure
    }
  }
  return worst
}

/** Formats a defensive, bounded percentage. */
export function formatContextPressurePercent(usedPercent: number): string {
  if (!Number.isFinite(usedPercent)) {
    return '0%'
  }
  return `${Math.max(0, Math.min(100, Math.round(usedPercent)))}%`
}
