/**
 * DISPOSABLE EXPERIMENT (STA-8667 D3). The automatic pacing policy as a pure module, shared by
 * the desktop mock, the serve host and the client in the harness, and by the policy probes.
 * Automatic only: there is no cadence setting. Module-level state on purpose (one host).
 */

export const POLICY_D3 = {
  SELECTED_BASE_MS: 60_000,
  VISIBLE_BASE_MS: 120_000,
  NO_REVIEW_VISIBLE_BASE_MS: 15 * 60_000,
  SELECTED_CAP_MS: 30 * 60_000,
  VISIBLE_CAP_MS: 60 * 60_000,
  UNKNOWN_MERGE_HOLD_MS: 10 * 60_000,
  STUCK_AFTER_MS: 30 * 60_000,
  STUCK_STEP_MS: 10 * 60_000,
  UNFOCUSED_PAUSE_AFTER_MS: 5 * 60_000
} as const

/** What the checks of a PR are doing, for scheduling only. `checksFinal` keeps its own meaning
 *  (complete AND non-empty AND nothing pending); it is not the inverse of "running" (D2-3). */
export type ChecksActivity = 'none' | 'settled' | 'running' | 'awaiting-approval' | 'incomplete'

type PRShape = {
  number: number
  state: string
  headSha?: string
  checksStatus?: string
  checksSummary?: { pending?: number; passed?: number; failed?: number; total?: number }
  checksFinal?: boolean
  checksReadComplete?: boolean
  failingCheckNames?: string[]
  mergeable?: string
  mergeStateStatus?: string | null
  reviewDecision?: string | null
  updatedAt?: string
}

export function checksActivity(p: Pick<PRShape, 'checksSummary' | 'checksFinal' | 'checksReadComplete' | 'checksStatus'>): ChecksActivity {
  // A partial read proves nothing about the checks that were not read.
  if (p.checksReadComplete === false) return 'incomplete'
  const s = p.checksSummary
  if (!s) {
    // Older outcome shape without counts: the aggregate status is all there is.
    if (p.checksFinal === false) return 'running'
    return p.checksStatus === 'pending' ? 'running' : 'settled'
  }
  if ((s.pending ?? 0) > 0) return 'running' // includes failed + running
  if ((s.total ?? 0) === 0) return 'none' // complete and empty: no CI on this head
  // Complete, non-empty, nothing pending, yet not final: a suite is waiting for approval.
  if (p.checksFinal === false) return 'awaiting-approval'
  return 'settled'
}

export function isRunningActivity(a: ChecksActivity): boolean {
  return a === 'running' || a === 'awaiting-approval' || a === 'incomplete'
}

type Meta = {
  signature: string
  unchanged: number
  runningSince: number | null
  unknownMergeSince: number | null
  hasPR: boolean
  state: string | null
  activity: ChecksActivity | null
  running: boolean
  unknownMerge: boolean
}

export const backoff = new Map<string, Meta>()
export const focus = { focused: true, blurredAt: 0 as number, visible: true }

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 0xffffffff
}

export function describe(outcome: { kind: string; pr?: Record<string, unknown> }): Omit<Meta, 'unchanged' | 'runningSince' | 'unknownMergeSince'> {
  if (outcome.kind !== 'found' || !outcome.pr) {
    return { signature: outcome.kind, hasPR: false, state: null, activity: null, running: false, unknownMerge: false }
  }
  const p = outcome.pr as PRShape
  const open = p.state === 'open' || p.state === 'draft'
  const activity = checksActivity(p)
  const running = (open || p.state === 'merged') && isRunningActivity(activity)
  const unknownMerge = open && p.mergeable === 'UNKNOWN' && !['CLEAN', 'BEHIND', 'BLOCKED'].includes(p.mergeStateStatus ?? '')
  return {
    signature: JSON.stringify([
      p.number,
      p.state,
      p.headSha,
      p.checksStatus,
      p.checksSummary ?? null,
      p.checksFinal ?? null,
      p.checksReadComplete ?? null,
      [...(p.failingCheckNames ?? [])].sort(),
      p.mergeable,
      p.mergeStateStatus ?? null,
      p.reviewDecision ?? null,
      p.updatedAt
    ]),
    hasPR: true,
    state: p.state,
    activity,
    running,
    unknownMerge
  }
}

export function note(key: string, outcome: { kind: string; pr?: Record<string, unknown> }): Meta {
  const d = describe(outcome)
  const prev = backoff.get(key)
  const same = prev !== undefined && prev.signature === d.signature
  const now = Date.now()
  const meta: Meta = {
    ...d,
    unchanged: same ? prev.unchanged + 1 : 0,
    runningSince: d.running ? (same ? (prev.runningSince ?? now) : now) : null,
    unknownMergeSince: d.unknownMerge ? (prev?.unknownMergeSince ?? now) : null
  }
  backoff.set(key, meta)
  return meta
}

/** Reset on selection, manual refresh, post-push and HEAD/generation change (not on window return). */
export function reset(key: string): void {
  const m = backoff.get(key)
  if (m) backoff.set(key, { ...m, unchanged: 0 })
}

/** Interval before the next timed upstream read; Infinity = no timed read.
 *  Jitter only shortens, so a cap stays a cap. */
export function interval(key: string, selected: boolean, anchor: number, jitter: number): number {
  const P = POLICY_D3
  const m = backoff.get(key)
  const j = (ms: number): number => (jitter > 0 ? Math.round(ms * (1 - jitter * hash(`${key}|${anchor}`))) : ms)
  if (!m) return selected ? P.SELECTED_BASE_MS : P.VISIBLE_BASE_MS
  const now = Date.now()
  const cap = selected ? P.SELECTED_CAP_MS : P.VISIBLE_CAP_MS
  const double = (base: number): number => Math.max(base, Math.min(cap, base * 2 ** Math.min(m.unchanged, 6)))
  // A non-selected row whose per-check picture has not moved for 30 min is a stuck check.
  const stuck = (base: number): number => {
    const frozenFor = m.runningSince === null ? 0 : now - m.runningSince
    if (!m.running || frozenFor < P.STUCK_AFTER_MS) return base
    const steps = Math.floor((frozenFor - P.STUCK_AFTER_MS) / P.STUCK_STEP_MS) + 1
    return j(Math.max(base, Math.min(P.VISIBLE_CAP_MS, base * 2 ** Math.min(steps, 5))))
  }
  if (!m.hasPR) return j(double(selected ? P.SELECTED_BASE_MS : P.NO_REVIEW_VISIBLE_BASE_MS))
  if (m.state === 'merged') {
    if (!m.running) return Number.POSITIVE_INFINITY
    return selected ? P.SELECTED_BASE_MS : stuck(P.SELECTED_BASE_MS)
  }
  if (m.state === 'closed') return j(double(P.NO_REVIEW_VISIBLE_BASE_MS))
  const unknownHolds = m.unknownMergeSince !== null && now - m.unknownMergeSince < P.UNKNOWN_MERGE_HOLD_MS
  if (m.running || unknownHolds) {
    if (selected) return P.SELECTED_BASE_MS
    return m.running ? stuck(P.VISIBLE_BASE_MS) : P.VISIBLE_BASE_MS
  }
  return j(double(selected ? P.SELECTED_BASE_MS : P.VISIBLE_BASE_MS))
}

/** The client's own interval when it has no usable host hint. `null` = no timed read. Uses the
 *  same completion-based classification as the host, so both agree on when a row is stopped. */
export function localInterval(outcome: { kind: string; pr?: Record<string, unknown> } | undefined, selected: boolean): number | null {
  const P = POLICY_D3
  if (!outcome) return selected ? P.SELECTED_BASE_MS : P.VISIBLE_BASE_MS
  const d = describe(outcome)
  if (!d.hasPR) return selected ? P.SELECTED_BASE_MS : P.NO_REVIEW_VISIBLE_BASE_MS
  if (d.state === 'merged') return d.running ? P.SELECTED_BASE_MS : null
  if (d.state === 'closed') return P.NO_REVIEW_VISIBLE_BASE_MS
  return selected ? P.SELECTED_BASE_MS : P.VISIBLE_BASE_MS
}

export function idle(): boolean {
  return !focus.focused && Date.now() - focus.blurredAt >= POLICY_D3.UNFOCUSED_PAUSE_AFTER_MS
}
