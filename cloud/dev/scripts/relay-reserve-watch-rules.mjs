// Stop rules for a cell watched in reserve mode (step 5 design §9, "Auto-abort per flip"). Pure:
// it takes one already-read sample and the watch state, and returns the next state and whether
// to flip the cell back. The reader lives in watch-relay-reserve-cell.mjs.
import { backgroundOf, SHADOW_GATE_THRESHOLDS } from './relay-same-cap-shadow-gate-verdict.mjs'

const MINUTE_MS = 60_000

export const RESERVE_WATCH_RULES = {
  // The roll ladder's warn line on non-drain 503s: max(1.5x, background + 20), so a zero background
  // is not tripped by one 503. Three complete minutes in a row, not two. The read spans more minutes
  // than that so a late publishing front still leaves three published minutes to judge.
  director503: {
    multiple: SHADOW_GATE_THRESHOLDS.nonDrain503Budget.warnMultiple,
    marginPerMinute: SHADOW_GATE_THRESHOLDS.nonDrain503Budget.warnMarginPerMinute,
    consecutiveMinutes: 3,
    readMinutes: 10,
    // Cloud Run publishes a minute's request count up to 3 minutes late.
    publishDelayMs: 3 * MINUTE_MS,
    // The roll ladder's one-minute would-block line, max(10x, 200), here held for 3 minutes. Every
    // broad fault since 09-09 ran in the thousands a minute; one stalled instance peaked at 178
    // (10-20/21) and never held 200 for 3 minutes.
    broad: {
      multiple: SHADOW_GATE_THRESHOLDS.nonDrain503Budget.spikeMultiple,
      floorPerMinute: SHADOW_GATE_THRESHOLDS.nonDrain503Budget.spikeFloor
    },
    // Between the two lines, two instances each over their even share of the fleet line for the
    // same 3 minutes. 10-21 07:55Z: no instance held a fifth, the stalled one fell to 5 in minute 3.
    instances: { minOver: 2 }
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

// Step 6 design §7: judged only while the cell's switch file says phonePath=memory, against the
// cell's own runtime metrics for the 10 minutes before phonePath went memory. A trip turns the
// phone path off (phonePath=db) and the watch goes on with the reserve rules.
export const PHONE_WATCH_RULES = {
  // Each rule trips on three complete minutes in a row over its line.
  consecutiveMinutes: 3,
  readMinutes: 10,
  // Judged as a share of the minute's phone attempts (the signal plus completed accepts; for
  // confirm failures, the accepts), not a count: a count line false-tripped 33/121 5-hour watches
  // on busy c28 (10-18/19), where bursts of refusals arrive with the evening rise in accepts. A
  // minute with fewer attempts is not judged, so low-volume c7 (~2 accepts/min) is mostly unjudged.
  minAttemptsPerMinute: 4,
  // Over half of the minute's attempts, and 0.25 above the share before the flip, capped so two
  // failures per accept always trips. Exactly half is not enough: c28 (04:08Z) and c7 (09:13Z)
  // both show 3 minutes at 50% of host-and-phone auth failures.
  shareFloor: 0.5,
  shareOverBackground: 0.25,
  shareCeiling: 0.6,
  // Page only: confirms still work, only their audit rows or renewals are lost.
  pageAfterMs: 5 * MINUTE_MS
}
export const PHONE_RULE_NAMES = [
  'phoneCredentialRefusals',
  'phoneConfirmFailures',
  'phoneAttachDeadlines',
  'phoneAcceptDatabaseErrors'
]
const PHONE_RULE_SIGNALS = {
  phoneCredentialRefusals: 'credentialRefusals',
  phoneConfirmFailures: 'confirmFailures',
  phoneAttachDeadlines: 'attachDeadlines',
  phoneAcceptDatabaseErrors: 'acceptDatabaseErrors'
}

const sum = (values) => values.reduce((total, value) => total + value, 0)

// The share line for a signal whose share of attempts before the flip was `backgroundShare`.
export function phoneShareLine(backgroundShare) {
  const { shareFloor, shareOverBackground, shareCeiling } = PHONE_WATCH_RULES
  return Math.min(shareCeiling, Math.max(shareFloor, backgroundShare + shareOverBackground))
}

// A completed accept makes one confirm, so confirm failures are a share of accepts (capped at
// all of them); every other signal is an attempt that did not complete.
function attemptsAndShare(signal, count, completedAccepts) {
  if (signal === 'confirmFailures') {
    return { attempts: completedAccepts, share: completedAccepts === 0 ? 0 : Math.min(count, completedAccepts) / completedAccepts }
  }
  const attempts = count + completedAccepts
  return { attempts, share: attempts === 0 ? 0 : count / attempts }
}

// Over the line: enough attempts that minute, and strictly more than the line refused or failed.
export function phoneMinuteOver(signal, count, completedAccepts, line) {
  const { attempts, share } = attemptsAndShare(signal, count, completedAccepts)
  return attempts >= PHONE_WATCH_RULES.minAttemptsPerMinute && share > line
}

// The 10 minutes before phonePath went memory, from `readCellPhoneMinutes`: each signal's share of
// attempts. Null until every minute is metered.
export function measuredPhoneBackground(read) {
  if (!read.ok || read.unmetered.length > 0 || read.minutes.length === 0) return null
  const accepted = sum(read.series.completedAccepts)
  return {
    share: Object.fromEntries(
      Object.values(PHONE_RULE_SIGNALS).map((signal) => {
        const count = sum(read.series[signal])
        return [signal, attemptsAndShare(signal, count, accepted).share]
      })
    ),
    minutes: read.minutes.length
  }
}

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
    seatBehindRowFirstSeen: {},
    // Step 6: what a trip writes back, and the phone rules' state. `phoneSince` is when the switch
    // file went phonePath=memory (flippedAt if it already said so); `phoneOffAt` when the watch
    // turned it off; `phoneTrip` a phone verdict the segment has yet to write.
    flip: null,
    lastSampleAt: null,
    phoneSince: null,
    phoneBackground: null,
    phoneOffAt: null,
    phoneTrip: null,
    phoneOffFailures: 0,
    phoneUnverifiableStreak: 0,
    auditDropsLast: null,
    auditDropsSince: null,
    renewalFailuresSince: null,
    paged: []
  }
}

// The background from the per-minute non-drain 503s before the flip, the live samples' measure.
// `publishedThrough` is the newest minute any response code has a point for: a 503 minute at or
// before it with no point had none, and the background waits (null) until it covers the last
// minute. Unmetered minutes are left out; under half the minutes metered is no background.
export function measuredBackground({ perMinute, minutes, publishedThrough, unmetered }) {
  if (minutes.length === 0 || publishedThrough === null || publishedThrough < minutes.at(-1)) return null
  const metered = minutes.filter((minute) => !unmetered.includes(minute))
  if (metered.length * 2 < minutes.length) return null
  const background = backgroundOf({ minutes: metered, series: metered.map((minute) => perMinute[minute] ?? 0), unverified: false })
  return { medianPerMinute: background.medianPerMinute, minutes: background.minutes, source: 'measured' }
}

const pass = (detail = {}) => ({ status: 'pass', ...detail })
const trip = (reason, detail = {}) => ({ status: 'trip', reason, ...detail })
const unverifiable = (reason) => ({ status: 'unverifiable', reason })
// Not readable yet by design, so it does not count toward the unverifiable streak.
const pending = (reason) => ({ status: 'pending', reason })
const failedPhoneRead = { ok: false, error: 'no cell phone metrics read' }
const minuteFloor = (at) => Math.floor(at / MINUTE_MS) * MINUTE_MS

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

// Fleet-wide non-drain director 503s: no existing signal attributes a 503 to the cell a host was
// bound for, so a problem local to one cell can stay under the fleet's line. This proxy can miss.
// Over the fleet line, it trips only when at least two instances are each over their share of it:
// one director instance whose database calls stall alone can carry the fleet over (10-21 07:55Z,
// 45/164/40 with 54/155/5 on one instance). Over the broad line no instance split is needed.
function judgeDirector503(read, state, at) {
  const { multiple, marginPerMinute, consecutiveMinutes, publishDelayMs, broad, instances } = RESERVE_WATCH_RULES.director503
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
  const unmetered = recent.filter((minute) => read.unmetered.includes(minute))
  if (unmetered.length > 0) return unverifiable(`no director runtime metrics for ${unmetered.join(', ')}`)
  const counts = recent.map((minute) => read.perMinute[minute] ?? 0)
  const broadLine = Math.max(perMinute * broad.multiple, broad.floorPerMinute)
  const detail = { backgroundPerMinute: perMinute, above, broadAbove: broadLine, recent: Object.fromEntries(recent.map((m, i) => [m, counts[i]])) }
  const sustained = `for ${consecutiveMinutes} min (${counts.join(', ')})`
  if (counts.every((count) => count > broadLine)) {
    return trip(`director 503s above ${broadLine}/min ${sustained}`, detail)
  }
  if (!counts.every((count) => count > above)) return pass(detail)
  if (!read.instances?.ok) return unverifiable(read.instances?.error ?? 'no per-instance director 503s')
  // The fewest directors logging in a judged minute, so a rollout's overlap cannot shrink the share.
  const directors = Math.min(...recent.map((minute) => read.instances.directors?.[minute]))
  if (!Number.isInteger(directors)) return unverifiable(`no director instance count for ${recent.join(', ')}`)
  const instanceAbove = above / Math.max(directors, instances.minOver)
  const over = Object.entries(read.instances.perMinute)
    .filter(([, byMinute]) => recent.every((minute) => (byMinute[minute] ?? 0) > instanceAbove))
    .map(([instance]) => instance)
  const split = { ...detail, instanceAbove, instancesOver: over.length }
  if (over.length >= instances.minOver) {
    return trip(`director 503s above ${above}/min ${sustained}, ${over.length} instances each above ${instanceAbove}/min`, split)
  }
  return pass(split)
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

// A counter still rising (or failing) every sample for 5 minutes pages once; a single drop does not.
function judgeSustained(rising, since, at) {
  const next = rising ? (since ?? at) : null
  return { since: next, sustained: next !== null && at - next >= PHONE_WATCH_RULES.pageAfterMs }
}

export function phoneSinceOf(cell, state) {
  if (state.phoneSince !== null || !cell.ok || cell.phonePathConfigured !== 'memory') return state.phoneSince
  // Memory from the first sample: the operator's flipped-at. Later: the sample before this one.
  return state.lastSampleAt === null ? state.flippedAt : state.lastSampleAt
}

// The phone rules for one sample, or none while the switch file does not say phonePath=memory.
function judgePhoneRules(cell, phone, state, at) {
  if (!cell.ok || cell.phonePathConfigured !== 'memory' || state.phoneOffAt !== null) return {}
  const background = state.phoneBackground
  if (!background) {
    const verdict =
      state.phoneSince === null
        ? unverifiable('the phone rules need --flipped-at: their background is the 10 minutes before it')
        : at < minuteFloor(state.phoneSince) + RESERVE_WATCH_RULES.director503.publishDelayMs
          ? pending('the phone background before phonePath went memory is not published yet')
          : unverifiable('no phone background yet')
    return Object.fromEntries(PHONE_RULE_NAMES.map((name) => [name, verdict]))
  }
  if (!phone.ok) return Object.fromEntries(PHONE_RULE_NAMES.map((name) => [name, unverifiable(phone.error)]))
  const { consecutiveMinutes } = PHONE_WATCH_RULES
  // Only the judged minutes need metrics; a gap earlier in the read changes nothing.
  const judged = phone.minutes.slice(-consecutiveMinutes)
  const gaps = phone.unmetered.filter((minute) => judged.includes(minute))
  if (gaps.length > 0) {
    const gap = unverifiable(`no cell runtime metrics for ${gaps.join(', ')}`)
    return Object.fromEntries(PHONE_RULE_NAMES.map((name) => [name, gap]))
  }
  const accepts = phone.series.completedAccepts.slice(-consecutiveMinutes)
  return Object.fromEntries(
    PHONE_RULE_NAMES.map((name) => {
      const signal = PHONE_RULE_SIGNALS[name]
      const line = phoneShareLine(background.share[signal])
      const recent = phone.series[signal].slice(-consecutiveMinutes)
      const detail = { backgroundShare: background.share[signal], line, recent, accepts }
      const over =
        recent.length === consecutiveMinutes && recent.every((count, index) => phoneMinuteOver(signal, count, accepts[index], line))
      return [
        name,
        over ? trip(`${signal} over ${Math.round(line * 100)}% of attempts for ${consecutiveMinutes} min (${recent.join(', ')} against ${accepts.join(', ')} accepts)`, detail) : pass(detail)
      ]
    })
  )
}

// Page-only signals: audit rows dropped since the previous sample, and renewal writes failing in
// every one of the last 5 published minutes.
function judgePhonePages(cell, phone, state, at) {
  const dropped = cell.ok && Number.isInteger(cell.resumeAuditDropped) ? cell.resumeAuditDropped : null
  const audit = judgeSustained(
    dropped !== null && state.auditDropsLast !== null && dropped > state.auditDropsLast,
    state.auditDropsSince,
    at
  )
  const renewals = phone?.ok ? (phone.series.renewalFailures ?? []).slice(-PHONE_WATCH_RULES.pageAfterMs / MINUTE_MS) : []
  const renewal = judgeSustained(renewals.length > 0 && renewals.every((count) => count > 0), state.renewalFailuresSince, at)
  const pages = []
  if (audit.sustained && !state.paged.includes('audit-drops')) pages.push('audit-drops')
  if (renewal.sustained && !state.paged.includes('renewal-failures')) pages.push('renewal-failures')
  return { auditDropsLast: dropped ?? state.auditDropsLast, auditDropsSince: audit.since, renewalFailuresSince: renewal.since, pages }
}

/**
 * One sample. `sample.cell` is the cell's runtime-status, `director503` the complete minutes of
 * non-drain director 503s with the request series' publishing front (`publishedThrough`) and the
 * minutes no runtime metrics cover (`unmetered`), `ledger` the placing directors' newest ledger summaries, `seatBehindRow` this
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
      return { state: next, rules, line: sampleLine(next, sample, rules), pages: [] }
    }
    // Someone else flipped it back (or it never became reserve): nothing left to watch.
    next.state = seen ? 'stopped' : 'refused'
    next.verdict = seen
      ? `${state.cellId} is not in reserve mode (switch file says ${cell.admitModeConfigured})`
      : `${state.cellId} did not report reserve mode within ${RESERVE_WATCH_RULES.reserveApplyWaitMs / MINUTE_MS} min (switch file says ${cell.admitModeConfigured})`
    return { state: next, rules: {}, line: sampleLine(next, sample, {}), pages: [] }
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
  next.lastSampleAt = at
  next.phoneSince = phoneSinceOf(cell, state)
  const phoneState = { ...state, phoneSince: next.phoneSince }
  const pageCheck = judgePhonePages(cell, sample.phone, state, at)
  next.auditDropsLast = pageCheck.auditDropsLast
  next.auditDropsSince = pageCheck.auditDropsSince
  next.renewalFailuresSince = pageCheck.renewalFailuresSince
  next.paged = [...state.paged, ...pageCheck.pages]
  const pages = pageCheck.pages
  const rules = {
    deadMan: judgeDeadMan(cell),
    overrun: judgeOverrun(cell),
    director503: judgeDirector503(sample.director503, state, at),
    duplicateSeat: duplicate.verdict,
    hostDrop: cell.ok ? judgeHostDrop(next.hosts) : unverifiable(cell.error),
    ledgerDrift: ledger.verdict,
    ...judgePhoneRules(cell, sample.phone ?? failedPhoneRead, phoneState, at)
  }
  const tripped = RULE_NAMES.find((name) => rules[name].status === 'trip')
  if (tripped) {
    next.state = 'tripped'
    next.flip = 'admitMode'
    next.verdict = `flip back ${state.cellId}: ${tripped}: ${rules[tripped].reason}`
    return { state: next, rules, line: sampleLine(next, sample, rules), pages }
  }
  // A phone trip turns off only the phone path; the segment writes it and the watch goes on.
  const phoneNames = PHONE_RULE_NAMES.filter((name) => name in rules)
  const phoneTripped = phoneNames.find((name) => rules[name].status === 'trip')
  const phoneMissing = phoneNames.filter((name) => rules[name].status === 'unverifiable')
  next.phoneUnverifiableStreak = phoneMissing.length > 0 ? state.phoneUnverifiableStreak + 1 : 0
  if (phoneTripped) {
    next.phoneTrip = `turn off the phone path on ${state.cellId}: ${phoneTripped}: ${rules[phoneTripped].reason}`
  } else if (next.phoneUnverifiableStreak >= unverifiableLimit) {
    next.phoneTrip =
      `turn off the phone path on ${state.cellId}: unverifiable: ${next.phoneUnverifiableStreak} samples ` +
      `in a row could not read ${phoneMissing.join(', ')}`
  }
  const missing = RULE_NAMES.filter((name) => rules[name].status === 'unverifiable')
  const waiting = [...RULE_NAMES, ...phoneNames].some((name) => rules[name].status === 'pending')
  // A pending rule holds the streak where it was: neither evidence of health nor a gap.
  next.unverifiableStreak = missing.length > 0 ? state.unverifiableStreak + 1 : waiting ? state.unverifiableStreak : 0
  if (next.unverifiableStreak >= unverifiableLimit) {
    next.state = 'tripped'
    next.flip = 'admitMode'
    next.verdict =
      `flip back ${state.cellId}: unverifiable: ${next.unverifiableStreak} samples in a row could not ` +
      `read ${missing.join(', ')}`
  } else if (at >= state.deadlineAt && next.phoneTrip) {
    // Still unwritten at the end: the workflow's flip back writes it, and pages if that fails too.
    next.state = 'tripped'
    next.flip = 'phonePath'
    next.verdict = `${next.phoneTrip}; phonePath=db did not land before the watch ended`
  } else if (at >= state.deadlineAt) {
    next.state = 'completed'
    next.verdict = `${state.cellId} stayed healthy in reserve mode for the whole watch`
  }
  return { state: next, rules, line: sampleLine(next, sample, rules), pages }
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
    ...(state.phoneTrip ? { phoneTrip: state.phoneTrip } : {}),
    ...(state.verdict ? { verdict: state.verdict } : {})
  })
}
