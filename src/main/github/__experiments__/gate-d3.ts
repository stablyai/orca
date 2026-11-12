/**
 * DISPOSABLE EXPERIMENT (STA-8667 design round D3). Harness branch only; never merge.
 *
 * Two admission gates for timed serve reads, with the same call shape so a scenario can run
 * "before" (the D2 gate, kept verbatim in behaviour) and "after" (the D3 lanes rule).
 *
 * Neither gate queues a request or holds one open. A refused caller gets a retry time; the gate
 * only remembers a claim (who was refused, how overdue, when it was told to return).
 */

export type GateLane = 'interactive' | 'selected' | 'visible'
export type StartLane = 'selected-own' | 'selected-borrowed' | 'visible'
export type GateDecision =
  | { admit: true; startLane: StartLane | 'interactive'; overdueMs: number; waitedMs: number }
  | { admit: false; retryAt: number }

export type GateEvent =
  | { t: number; kind: 'start'; lane: StartLane | 'interactive'; key: string; client: number; overdueMs: number; waitedMs: number }
  | { t: number; kind: 'refuse'; lane: GateLane; key: string; client: number; retryAt: number }

export type Gate = {
  name: 'd2' | 'd3'
  request: (client: number, key: string, lane: GateLane, dueSince: number, honoursHints: boolean) => GateDecision
  events: GateEvent[]
}

export const GATE_D3 = {
  WINDOW_MS: 5 * 60_000,
  /** Starts per rolling window that only selected reads can use. Never spaced. */
  SELECTED_SHARE: 5,
  /** Starts per rolling window for visible reads. Spaced. Selected may borrow from it. */
  VISIBLE_SHARE: 15,
  /** Most visible-share starts selected reads may hold in one window. */
  BORROW_MAX: 5,
  /** Minimum distance between two starts that come out of the visible share. */
  SPACING_MS: 10_000,
  /** How long a claim outlives the time its caller was told to return. */
  CLAIM_GRACE_MS: 15_000,
  /** Shortest retry hint for a refused selected read. */
  SELECTED_RETRY_MIN_MS: 5_000
} as const

type Claim = { lane: 'selected' | 'visible'; dueSince: number; first: number; retryAt: number; until: number }

/** D3: reserved lanes. See the design document §4.4 for the rule in prose. */
export function createGateD3(now: () => number = Date.now, overrides: Partial<Record<keyof typeof GATE_D3, number>> = {}): Gate {
  const C = { ...GATE_D3, ...overrides }
  const starts: { t: number; lane: StartLane }[] = []
  const claims = new Map<string, Claim>()
  const events: GateEvent[] = []
  let lastSpacedStart = -Infinity

  const prune = (t: number): void => {
    while (starts.length > 0 && t - starts[0].t >= C.WINDOW_MS) starts.shift()
    for (const [k, v] of claims) if (v.until < t) claims.delete(k)
  }
  const count = (lane: StartLane): number => starts.reduce((n, s) => n + (s.lane === lane ? 1 : 0), 0)
  /** When the n-th oldest start of the given lanes leaves the window (n = how many must leave). */
  const freesAt = (lanes: StartLane[], mustLeave: number): number => {
    const mine = starts.filter((s) => lanes.includes(s.lane))
    return mine[mustLeave - 1].t + C.WINDOW_MS
  }

  const request: Gate['request'] = (client, key, lane, dueSince, honoursHints) => {
    const t = now()
    prune(t)
    const start = (startLane: StartLane | 'interactive'): GateDecision => {
      const claim = claims.get(key)
      const mine = claim?.dueSince ?? dueSince
      const decision = { admit: true as const, startLane, overdueMs: Math.max(0, t - mine), waitedMs: claim ? t - claim.first : 0 }
      claims.delete(key)
      if (startLane !== 'interactive') {
        starts.push({ t, lane: startLane })
        if (startLane !== 'selected-own') lastSpacedStart = t
      }
      events.push({ t, kind: 'start', lane: startLane, key, client, overdueMs: decision.overdueMs, waitedMs: decision.waitedMs })
      return decision
    }
    // The interactive lane is limited per client by the caller (3 per 30 s), not by this budget.
    if (lane === 'interactive') return start('interactive')

    const mine = claims.get(key)?.dueSince ?? dueSince
    // Claims of the same lane that are more overdue than this caller. Only one whose caller was
    // told to be back by now can make this caller wait (work-conserving when a claimant is absent).
    let ahead = 0
    let aheadHere = 0
    let liveVisibleClaim = false
    for (const [k, v] of claims) {
      if (v.lane === 'visible' && k !== key) liveVisibleClaim = true
      if (k === key || v.lane !== lane || v.dueSince > mine || (v.dueSince === mine && k > key)) continue
      ahead += 1
      if (v.retryAt <= t) aheadHere += 1
    }
    const refuse = (retryAt: number): GateDecision => {
      const existing = claims.get(key)
      claims.set(key, {
        lane,
        dueSince: mine,
        first: existing?.first ?? t,
        retryAt: honoursHints ? retryAt : Number.POSITIVE_INFINITY,
        until: honoursHints ? retryAt + C.CLAIM_GRACE_MS : t + C.WINDOW_MS
      })
      events.push({ t, kind: 'refuse', lane, key, client, retryAt })
      return { admit: false, retryAt }
    }

    const own = count('selected-own')
    const borrowed = count('selected-borrowed')
    const visible = count('visible')
    const shareUsed = visible + borrowed
    const spacingFreeAt = lastSpacedStart + C.SPACING_MS

    if (lane === 'selected') {
      const ownFreeAt = own < C.SELECTED_SHARE ? t : freesAt(['selected-own'], own - C.SELECTED_SHARE + 1)
      // Borrowing takes a start out of the visible share. It is allowed only while no visible
      // identity is waiting, never beyond BORROW_MAX, and it keeps the visible spacing.
      const mayBorrow = borrowed < C.BORROW_MAX && shareUsed < C.VISIBLE_SHARE && !liveVisibleClaim
      if (aheadHere === 0) {
        if (ownFreeAt <= t) return start('selected-own')
        if (mayBorrow && spacingFreeAt <= t) return start('selected-borrowed')
      }
      const freeAt = Math.min(ownFreeAt, mayBorrow ? Math.max(t, spacingFreeAt) : Number.POSITIVE_INFINITY)
      return refuse(Math.max(t + C.SELECTED_RETRY_MIN_MS, freeAt + ahead * C.SPACING_MS))
    }

    const shareFreeAt =
      shareUsed < C.VISIBLE_SHARE ? t : freesAt(['visible', 'selected-borrowed'], shareUsed - C.VISIBLE_SHARE + 1)
    const freeAt = Math.max(t, shareFreeAt, spacingFreeAt)
    if (freeAt <= t && aheadHere === 0) return start('visible')
    return refuse(Math.max(t + C.SPACING_MS, freeAt + ahead * C.SPACING_MS))
  }

  return { name: 'd3', request, events }
}

/** D2 gate: behaviour identical to `createGate` in the frozen D2 harness (sha256 14cba0fe…0eb).
 *  Only the bookkeeping (events, decision shape) differs. Kept as the "before" for D2-2. */
export function createGateD2(now: () => number = Date.now): Gate {
  const WINDOW = 5 * 60_000
  const MAX = 20
  const SPACING = 10_000
  const SELECTED_RESERVE = 4
  const GRACE = 15_000
  const starts: number[] = []
  let lastVisibleStart = -Infinity
  const claims = new Map<string, { dueSince: number; first: number; retryAt: number; until: number }>()
  const events: GateEvent[] = []
  const prune = (t: number): void => {
    while (starts.length > 0 && t - starts[0] >= WINDOW) starts.shift()
    for (const [k, v] of claims) if (v.until < t) claims.delete(k)
  }
  const request: Gate['request'] = (client, key, lane, dueSince, honoursHints) => {
    const t = now()
    prune(t)
    const admit = (): GateDecision => {
      const claim = claims.get(key)
      const mineDue = claim?.dueSince ?? dueSince
      const startLane = lane === 'selected' ? 'selected-own' : lane
      const decision = { admit: true as const, startLane, overdueMs: Math.max(0, t - mineDue), waitedMs: claim ? t - claim.first : 0 }
      claims.delete(key)
      if (lane !== 'interactive') starts.push(t)
      if (lane === 'visible') lastVisibleStart = t
      events.push({ t, kind: 'start', lane: startLane, key, client, overdueMs: decision.overdueMs, waitedMs: decision.waitedMs })
      return decision
    }
    if (lane === 'interactive') return admit()
    const windowFreeAt = starts.length >= MAX ? starts[0] + WINDOW : t
    if (lane === 'selected') {
      if (windowFreeAt > t) {
        events.push({ t, kind: 'refuse', lane, key, client, retryAt: windowFreeAt })
        return { admit: false, retryAt: windowFreeAt }
      }
      return admit()
    }
    const visibleMax = MAX - SELECTED_RESERVE
    const visibleWindowFreeAt = starts.length >= visibleMax ? starts[starts.length - visibleMax] + WINDOW : t
    const freeAt = Math.max(t, visibleWindowFreeAt, lastVisibleStart + SPACING)
    const mine = claims.get(key)?.dueSince ?? dueSince
    let ahead = 0
    let aheadHere = 0
    for (const [k, v] of claims) {
      if (k === key || v.dueSince > mine || (v.dueSince === mine && k > key)) continue
      ahead += 1
      if (v.retryAt <= t) aheadHere += 1
    }
    if (freeAt <= t && aheadHere === 0) return admit()
    const retryAt = Math.max(t + SPACING, freeAt + ahead * SPACING)
    const existing = claims.get(key)
    claims.set(key, {
      dueSince: mine,
      first: existing?.first ?? t,
      retryAt: honoursHints ? retryAt : Number.POSITIVE_INFINITY,
      until: honoursHints ? retryAt + GRACE : t + 16 * 60_000
    })
    events.push({ t, kind: 'refuse', lane, key, client, retryAt })
    return { admit: false, retryAt }
  }
  return { name: 'd2', request, events }
}

export function rollingPeak(times: number[], windowMs: number): number {
  let peak = 0
  let lo = 0
  for (let hi = 0; hi < times.length; hi++) {
    while (times[hi] - times[lo] >= windowMs) lo++
    peak = Math.max(peak, hi - lo + 1)
  }
  return peak
}

/** Per-lane summary of a gate's event log. Times are whatever clock the gate was given. */
export function summarizeGate(gate: Gate, t0: number, endT: number) {
  const starts = gate.events.filter((e): e is Extract<GateEvent, { kind: 'start' }> => e.kind === 'start')
  const budgeted = starts.filter((e) => e.lane !== 'interactive')
  const byLane = (lane: string) => starts.filter((e) => e.lane === lane)
  const pct = (v: number[], p: number): number | null => {
    if (v.length === 0) return null
    const s = [...v].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
  }
  const sec = (ms: number | null): number | null => (ms === null ? null : Math.round(ms / 1000))
  const lane = (name: string) => {
    const rows = byLane(name)
    const overdue = rows.map((e) => e.overdueMs)
    const waited = rows.map((e) => e.waitedMs)
    return {
      starts: rows.length,
      overdueAtStartS: { p50: sec(pct(overdue, 50)), p90: sec(pct(overdue, 90)), max: sec(overdue.length ? Math.max(...overdue) : null) },
      // Time from the first refusal of this due period to the start (0 = admitted on first ask).
      waitedSinceFirstRefusalS: { p50: sec(pct(waited, 50)), p90: sec(pct(waited, 90)), max: sec(waited.length ? Math.max(...waited) : null) },
      peak60s: rollingPeak(rows.map((e) => e.t), 60_000),
      peak5min: rollingPeak(rows.map((e) => e.t), 5 * 60_000)
    }
  }
  // Visible identities: every key that asked on the visible lane. A key counts as served once it
  // has a start on ANY lane after it was first seen there (a row one client has selected is read
  // through the selected lane and every other client rides along from the store).
  const visibleFirstSeen = new Map<string, number>()
  for (const e of gate.events) {
    const lane = e.kind === 'refuse' ? e.lane : e.lane
    if (lane === 'visible' && !visibleFirstSeen.has(e.key)) visibleFirstSeen.set(e.key, e.t)
  }
  const visibleKeys = new Set(visibleFirstSeen.keys())
  let worstGapMs = 0
  let neverServed = 0
  for (const [key, firstSeen] of visibleFirstSeen) {
    const first = starts.find((e) => e.key === key && e.t >= firstSeen)
    if (!first) {
      neverServed += 1
      worstGapMs = Math.max(worstGapMs, endT - firstSeen)
      continue
    }
    worstGapMs = Math.max(worstGapMs, first.t - firstSeen)
  }
  const selectedAll = starts.filter((e) => e.lane === 'selected-own' || e.lane === 'selected-borrowed')
  return {
    gate: gate.name,
    simulatedSeconds: Math.round((endT - t0) / 1000),
    lanes: {
      'selected-own': lane('selected-own'),
      'selected-borrowed': lane('selected-borrowed'),
      visible: lane('visible'),
      interactive: lane('interactive')
    },
    selectedTotal: {
      starts: selectedAll.length,
      peak60s: rollingPeak(selectedAll.map((e) => e.t), 60_000),
      peak5min: rollingPeak(selectedAll.map((e) => e.t), 5 * 60_000)
    },
    budgeted: {
      starts: budgeted.length,
      peak60s: rollingPeak(budgeted.map((e) => e.t), 60_000),
      peak5min: rollingPeak(budgeted.map((e) => e.t), 5 * 60_000)
    },
    refusals: {
      selected: gate.events.filter((e) => e.kind === 'refuse' && e.lane === 'selected').length,
      visible: gate.events.filter((e) => e.kind === 'refuse' && e.lane === 'visible').length
    },
    visibleIdentities: { seen: visibleKeys.size, neverServed, worstWaitFromFirstSeenToFirstStartS: Math.round(worstGapMs / 1000) }
  }
}
