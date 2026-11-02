// Stop rules for a cell watched in reserve mode (step 5 design §9, "Auto-abort per flip"). Pure:
// it takes one already-read sample and the watch state, and returns the next state and whether
// to flip the cell back. The reader lives in watch-relay-reserve-cell.mjs.
import { backgroundOf, SHADOW_GATE_THRESHOLDS } from './relay-same-cap-shadow-gate-verdict.mjs'

const MINUTE_MS = 60_000

export const RESERVE_WATCH_RULES = {
  // The roll ladder's warn line: max(1.5x, background + 20), so a zero background is not tripped
  // by one 503. Three complete minutes in a row, not two. The read spans more minutes than that so
  // a late publishing front still leaves three published minutes to judge.
  director503: {
    multiple: SHADOW_GATE_THRESHOLDS.nonDrain503Budget.warnMultiple,
    marginPerMinute: SHADOW_GATE_THRESHOLDS.nonDrain503Budget.warnMarginPerMinute,
    consecutiveMinutes: 3,
    readMinutes: 10,
    // Cloud Run publishes a minute's request count up to 3 minutes late.
    publishDelayMs: 3 * MINUTE_MS
  },
  // The cell closes a demoted seat after 60 s (DEMOTION_CLOSE_MS); 30 s more covers a director's
  // map still holding the closed seat.
  duplicateSeat: { graceMs: 60_000 + 30_000, lookbackMs: 15 * MINUTE_MS },
  // The floor keeps an almost empty cell's ordinary churn from reading as a 5% drop.
  hostDrop: { share: 0.05, windowMs: 5 * MINUTE_MS, minHosts: 10 },
  ledgerDrift: { share: 0.005, sustainMs: 2 * MINUTE_MS },
  // A placing director logs its ledger summary every 60 s; none in this long is no evidence.
  ledgerSummaryMaxAgeMs: 150_000,
  // A watch dispatched before the reserve write applies waits this long for the cell to report it.
  reserveApplyWaitMs: 10 * MINUTE_MS
}

// Precedence: the first tripped rule names the verdict, so exact signals come before proxies. The
// sample line's `rules` keys follow this order too.
export const RULE_NAMES = ['deadMan', 'overrun', 'director503', 'duplicateSeat', 'hostDrop', 'ledgerDrift']

export function initialWatchState({ cellId, startedAt, durationMinutes, background503PerMinute, flippedAt }) {
  return {
    v: 1,
    cellId,
    startedAt,
    deadlineAt: startedAt + durationMinutes * MINUTE_MS,
    state: 'watching',
    verdict: null,
    samples: 0,
    unverifiableStreak: 0,
    // The background is measured in the minutes before the flip, unless the operator supplied it.
    flippedAt: flippedAt ?? null,
    background:
      background503PerMinute === null ? null : { medianPerMinute: background503PerMinute, source: 'input' },
    hosts: [],
    reserveSeenAt: null,
    ledgerAboveSince: null,
    seatBehindRowFirstSeen: {}
  }
}

// The background from the per-minute 503 counts before the flip. `publishedThrough` is the newest
// minute any response code has a point for: a 503 minute at or before it with no point had none,
// and the background waits (null) until it covers the last minute.
export function measuredBackground(perMinute, minutes, publishedThrough) {
  if (minutes.length === 0 || publishedThrough === null || publishedThrough < minutes.at(-1)) return null
  const background = backgroundOf({ minutes, series: minutes.map((minute) => perMinute[minute] ?? 0), unverified: false })
  return { medianPerMinute: background.medianPerMinute, minutes: background.minutes, source: 'measured' }
}

const pass = (detail = {}) => ({ status: 'pass', ...detail })
const trip = (reason, detail = {}) => ({ status: 'trip', reason, ...detail })
const unverifiable = (reason) => ({ status: 'unverifiable', reason })
// Not readable yet by design, so it does not count toward the unverifiable streak.
const pending = (reason) => ({ status: 'pending', reason })

function judgeDeadMan(cell) {
  if (!cell.ok) return unverifiable(cell.error)
  if (cell.admitModeEffective !== 'db' && cell.admitModeEffective !== 'reserve') {
    return unverifiable('runtime-status reports no admitModeEffective')
  }
  if (cell.admitModeEffective === 'db') {
    return trip('the cell tripped its dead-man (reserve configured, db effective); Postgres still records reserve')
  }
  return pass()
}

// The cell ledger's total (seats, bookings, in-flight and phone units) against its hard cap. The
// ledger refuses past the cap, so this is an invariant check: it trips only if that refusal broke.
function judgeOverrun(cell) {
  if (!cell.ok) return unverifiable(cell.error)
  if (!Number.isInteger(cell.hardCap) || !Number.isInteger(cell.enforcedUnits)) {
    return unverifiable('runtime-status reports no hard cap or ledger units')
  }
  if (cell.enforcedUnits > cell.hardCap) {
    return trip(`ledger units ${cell.enforcedUnits} over hard cap ${cell.hardCap}`, {
      enforcedUnits: cell.enforcedUnits,
      hardCap: cell.hardCap
    })
  }
  return pass({ enforcedUnits: cell.enforcedUnits, hardCap: cell.hardCap })
}

// Fleet-wide director 503s: no existing signal attributes a 503 to the cell a host was bound for,
// so a problem local to one cell can stay under the fleet's line. This proxy can miss.
function judgeDirector503(read, state, at) {
  const { multiple, marginPerMinute, consecutiveMinutes, publishDelayMs } = RESERVE_WATCH_RULES.director503
  const { background } = state
  if (!background) {
    const publishesAt = state.flippedAt === null ? null : Math.floor(state.flippedAt / MINUTE_MS) * MINUTE_MS + publishDelayMs
    if (publishesAt !== null && at < publishesAt) return pending('the 503 background before the flip is not published yet')
    return unverifiable('no 503 background yet')
  }
  if (!read.ok) return unverifiable(read.error)
  const perMinute = background.medianPerMinute
  const above = Math.max(perMinute * multiple, perMinute + marginPerMinute)
  // Minute keys sort as time. Only minutes the publishing front has reached are judged: a 503
  // minute there with no point had none, one past it is not published yet and is left out.
  if (read.publishedThrough === null) return unverifiable('the director request series is empty')
  const recent = read.minutes.filter((minute) => minute <= read.publishedThrough).slice(-consecutiveMinutes)
  if (recent.length < consecutiveMinutes) {
    return unverifiable(`director requests are published only through ${read.publishedThrough}`)
  }
  const counts = recent.map((minute) => read.perMinute[minute] ?? 0)
  const detail = { backgroundPerMinute: perMinute, above, recent: Object.fromEntries(recent.map((m, i) => [m, counts[i]])) }
  if (counts.every((count) => count > above)) {
    return trip(`director 503s above ${above}/min for ${consecutiveMinutes} min (${counts.join(', ')})`, detail)
  }
  return pass(detail)
}

// A seat the ledger reconcile found behind its row and found again after the demotion should
// have closed it. The line names no host, so (director instance, cell, epoch, rowEpoch) stands in
// for one: a proxy that can only over-count, when two hosts share that key.
function judgeDuplicateSeat(read, firstSeen, at) {
  if (!read.ok) return { verdict: unverifiable(read.error), firstSeen }
  const { graceMs, lookbackMs } = RESERVE_WATCH_RULES.duplicateSeat
  const next = Object.fromEntries(
    Object.entries(firstSeen).filter(([, seenAt]) => seenAt >= at - 2 * lookbackMs)
  )
  for (const report of [...read.reports].sort((left, right) => left.at - right.at)) {
    next[report.key] = Math.min(next[report.key] ?? report.at, report.at)
  }
  for (const report of read.reports) {
    const ageMs = report.at - next[report.key]
    if (ageMs > graceMs) {
      return {
        verdict: trip(`a seat behind its ledger row (${report.key}) is still seated ${Math.round(ageMs / 1000)} s after first report`),
        firstSeen: next
      }
    }
  }
  return { verdict: pass({ reportsInLookback: read.reports.length }), firstSeen: next }
}

function judgeHostDrop(hosts) {
  const { share, minHosts, windowMs } = RESERVE_WATCH_RULES.hostDrop
  const current = hosts.at(-1)
  if (!current) return unverifiable('no host count')
  if (hosts.some((entry) => entry.draining)) return pass({ controls: current.controls, draining: true })
  const peak = Math.max(...hosts.map((entry) => entry.controls))
  const drop = peak - current.controls
  const detail = { controls: current.controls, peakInWindow: peak }
  if (peak > 0 && drop >= minHosts && drop / peak > share) {
    return trip(`connected hosts fell ${peak} -> ${current.controls} within ${windowMs / MINUTE_MS} min outside a drain`, detail)
  }
  return pass(detail)
}

// Rows the placing directors have not written (queued) or gave up on (dropped), per seat. The
// summaries are fleet-wide: exact while this is the only reserve cell, an over-count otherwise.
function judgeLedgerDrift(cell, ledger, aboveSince, at) {
  if (!cell.ok) return { verdict: unverifiable(cell.error), aboveSince }
  if (!ledger.ok) return { verdict: unverifiable(ledger.error), aboveSince }
  const { share, sustainMs } = RESERVE_WATCH_RULES.ledgerDrift
  const ratio = ledger.unwrittenRows / Math.max(cell.controls, 1)
  const detail = { unwrittenRows: ledger.unwrittenRows, directors: ledger.directors, ratio }
  if (ratio <= share) return { verdict: pass(detail), aboveSince: null }
  const since = aboveSince ?? at
  if (at - since >= sustainMs) {
    return {
      verdict: trip(`ledger drift ${(ratio * 100).toFixed(2)}% for ${Math.round((at - since) / 1000)} s`, detail),
      aboveSince: since
    }
  }
  return { verdict: pass({ ...detail, aboveForMs: at - since }), aboveSince: since }
}

/**
 * One sample. `sample.cell` is the cell's runtime-status, `director503` the complete minutes of
 * director 503s with the request series' publishing front (`publishedThrough`), `ledger` the placing directors' newest ledger summaries, `seatBehindRow` this
 * cell's reconcile reports in the lookback. Each is `{ ok: false, error }` when it could not be read.
 */
export function evaluateWatchSample(state, sample, { unverifiableLimit }) {
  const at = sample.at
  const next = { ...state, samples: state.samples + 1 }
  const { cell } = sample
  if (cell.ok && cell.admitModeConfigured !== 'reserve') {
    const seen = state.reserveSeenAt !== null
    if (!seen && at < state.startedAt + RESERVE_WATCH_RULES.reserveApplyWaitMs) {
      // Not judged, and the streak holds: the reserve write may not have applied yet.
      const rules = { reserve: pending(`switch file says ${cell.admitModeConfigured}; waiting for reserve to apply`) }
      return { state: next, rules, line: sampleLine(next, sample, rules) }
    }
    // Someone else flipped it back (or it never became reserve): nothing left to watch.
    next.state = seen ? 'stopped' : 'refused'
    next.verdict = seen
      ? `${state.cellId} is not in reserve mode (switch file says ${cell.admitModeConfigured})`
      : `${state.cellId} did not report reserve mode within ${RESERVE_WATCH_RULES.reserveApplyWaitMs / MINUTE_MS} min (switch file says ${cell.admitModeConfigured})`
    return { state: next, rules: {}, line: sampleLine(next, sample, {}) }
  }
  if (cell.ok) {
    next.reserveSeenAt = state.reserveSeenAt ?? at
    next.hosts = [...state.hosts, { at, controls: cell.controls, draining: cell.draining }].filter(
      (entry) => entry.at > at - RESERVE_WATCH_RULES.hostDrop.windowMs
    )
  }
  const duplicate = judgeDuplicateSeat(sample.seatBehindRow, state.seatBehindRowFirstSeen, at)
  next.seatBehindRowFirstSeen = duplicate.firstSeen
  const ledger = judgeLedgerDrift(cell, sample.ledger, state.ledgerAboveSince, at)
  next.ledgerAboveSince = ledger.aboveSince
  const rules = {
    deadMan: judgeDeadMan(cell),
    overrun: judgeOverrun(cell),
    director503: judgeDirector503(sample.director503, state, at),
    duplicateSeat: duplicate.verdict,
    hostDrop: cell.ok ? judgeHostDrop(next.hosts) : unverifiable(cell.error),
    ledgerDrift: ledger.verdict
  }
  const tripped = RULE_NAMES.find((name) => rules[name].status === 'trip')
  if (tripped) {
    next.state = 'tripped'
    next.verdict = `flip back ${state.cellId}: ${tripped}: ${rules[tripped].reason}`
    return { state: next, rules, line: sampleLine(next, sample, rules) }
  }
  const missing = RULE_NAMES.filter((name) => rules[name].status === 'unverifiable')
  const waiting = RULE_NAMES.some((name) => rules[name].status === 'pending')
  // A pending rule holds the streak where it was: neither evidence of health nor a gap.
  next.unverifiableStreak = missing.length > 0 ? state.unverifiableStreak + 1 : waiting ? state.unverifiableStreak : 0
  if (next.unverifiableStreak >= unverifiableLimit) {
    next.state = 'tripped'
    next.verdict =
      `flip back ${state.cellId}: unverifiable: ${next.unverifiableStreak} samples in a row could not ` +
      `read ${missing.join(', ')}`
  } else if (at >= state.deadlineAt) {
    next.state = 'completed'
    next.verdict = `${state.cellId} stayed healthy in reserve mode for the whole watch`
  }
  return { state: next, rules, line: sampleLine(next, sample, rules) }
}

function sampleLine(state, sample, rules) {
  return JSON.stringify({
    event: 'orca_relay_reserve_watch_sample',
    cellId: state.cellId,
    at: new Date(sample.at).toISOString(),
    sample: state.samples,
    state: state.state,
    unverifiableStreak: state.unverifiableStreak,
    rules,
    ...(state.verdict ? { verdict: state.verdict } : {})
  })
}
