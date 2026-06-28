import type { AgentStatusState } from '../../shared/agent-status-types'
import type { RuntimeWorktreeStatus } from '../../shared/runtime-types'

/** The four worktree states, in attention-priority order. */
export type StatusIndicatorKind = 'blocked' | 'working' | 'done' | 'idle'

export type StatusIndicator = {
  kind: StatusIndicatorKind
  /** Distinct shapes so the state reads without color (NO_COLOR / mono terms). */
  glyph: string
  /** Ink color name; views drop color when NO_COLOR is set. */
  color: 'red' | 'yellow' | 'blue' | 'gray'
  label: string
}

const INDICATORS: Record<StatusIndicatorKind, StatusIndicator> = {
  blocked: { kind: 'blocked', glyph: '◆', color: 'red', label: 'blocked' },
  working: { kind: 'working', glyph: '●', color: 'yellow', label: 'working' },
  done: { kind: 'done', glyph: '✓', color: 'blue', label: 'done' },
  idle: { kind: 'idle', glyph: '○', color: 'gray', label: 'idle' }
}

export function indicatorFor(kind: StatusIndicatorKind): StatusIndicator {
  return INDICATORS[kind]
}

function agentDemandsAttention(state: AgentStatusState): boolean {
  return state === 'blocked' || state === 'waiting'
}

/** Reduce a worktree's status plus its agents' states into a single indicator
 *  kind. "Needs you" (blocked/permission) wins over working, then done, then
 *  idle — so a worktree that needs the user never hides behind a busy agent. */
export function worktreeIndicatorKind(
  status: RuntimeWorktreeStatus,
  agents: readonly { state: AgentStatusState }[]
): StatusIndicatorKind {
  if (status === 'permission' || agents.some((a) => agentDemandsAttention(a.state))) {
    return 'blocked'
  }
  if (status === 'working' || agents.some((a) => a.state === 'working')) {
    return 'working'
  }
  if (status === 'done' || agents.some((a) => a.state === 'done')) {
    return 'done'
  }
  return 'idle'
}

// ─── Anti-flicker debounce ───────────────────────────────────────────────────
// Raw state can flip working→idle→working between ticks. Hold a working→idle
// transition until it's confirmed (N consecutive reconciles or a time cap) so
// the sidebar doesn't strobe. Every other transition publishes immediately —
// especially →blocked, which must surface the moment an agent needs the user.

export const IDLE_CONFIRMATIONS = 3
export const IDLE_HOLD_CAP_MS = 700

export type IndicatorDebounceState = {
  published: StatusIndicatorKind
  pendingSince: number | null
  confirmations: number
}

export function initialDebounceState(kind: StatusIndicatorKind): IndicatorDebounceState {
  return { published: kind, pendingSince: null, confirmations: 0 }
}

export type ReconcileOptions = {
  confirmations?: number
  holdCapMs?: number
}

/** Fold the next raw kind into the debounce state, returning the kind to show. */
export function reconcileIndicator(
  state: IndicatorDebounceState,
  next: StatusIndicatorKind,
  now: number,
  options: ReconcileOptions = {}
): { state: IndicatorDebounceState; published: StatusIndicatorKind } {
  const confirmations = options.confirmations ?? IDLE_CONFIRMATIONS
  const holdCapMs = options.holdCapMs ?? IDLE_HOLD_CAP_MS

  if (next === state.published) {
    return {
      state: { published: state.published, pendingSince: null, confirmations: 0 },
      published: state.published
    }
  }

  const isWorkingToIdle = state.published === 'working' && next === 'idle'
  if (!isWorkingToIdle) {
    // Immediate transition (incl. →blocked/working/done): publish now.
    return { state: initialDebounceState(next), published: next }
  }

  if (state.pendingSince === null) {
    return {
      state: { published: 'working', pendingSince: now, confirmations: 0 },
      published: 'working'
    }
  }

  const elapsed = now - state.pendingSince
  const nextConfirmations = state.confirmations + 1
  if (elapsed >= holdCapMs || nextConfirmations >= confirmations) {
    return { state: initialDebounceState('idle'), published: 'idle' }
  }

  return {
    state: {
      published: 'working',
      pendingSince: state.pendingSince,
      confirmations: nextConfirmations
    },
    published: 'working'
  }
}
