// Windowing, thresholds, and the verdict for the same-cap post-wave shadow health gate. Pure: it
// takes already-read log samples and returns a judgement, so every rule here is unit-testable
// without touching production. The reader lives in relay-same-cap-shadow-gate.mjs.

// Status vocabulary, worst-first. 'unverified' is a read that did not complete or that hit the
// entry limit; it can never settle to 'pass', because a truncated count is not evidence of calm.
// A partial count already past a block line is a block, though: more data only adds to it.
export const CHECK_STATUSES = ['would-block', 'unverified', 'warn', 'pass']

export const VERDICTS = { PASS: 'PASS', WARN: 'WARN', WOULD_BLOCK: 'WOULD_BLOCK' }

// Cloud Logging silently returns only `--limit` entries, so every read is split into sub-windows
// this long and a sub-window that comes back exactly at the limit is reported as truncated.
export const SUB_WINDOW_MINUTES = 10

export const ENTRY_LIMIT = 20000

// The 503 background is the same day's minutes just before the drain, not the same minutes a day
// or two earlier: a busy morning doubled 10-02's rate against both, and a baseline that held an
// incident blinded the comparison for four cells of that wave.
export const BACKGROUND_MINUTES = 10

// The asia-east2 cells share a 16-connection pool at 176 ms RTT, which is where pool pressure
// shows up first for the whole fleet. A cell joins only once it serves: zero samples read as
// unverified, so listing a not-yet-general cell would turn every verdict into WARN.
export const FLEET_POOL_CELL_IDS = [
  'production-gce-c27',
  'production-gce-c28',
  'production-gce-c29',
  'production-gce-c30',
  'production-gce-c31'
]

export const SHADOW_GATE_THRESHOLDS = {
  // One sample at 71 waiters is a burst that drains; three in a row is a pool that does not.
  pool: { waitersMax: 50, waitersConsecutiveSamples: 3, sqlFailuresDelta: 200 },
  // Pace-ladder rung budget (cloud/docs/relay-workflows.md), on non-drain 503s against the
  // pre-drain median. One ordinary minute over is a transient; two in a row past max(1.5x, +20)
  // warn and past max(2x, +40) is the abort. One minute past max(10x, 200) is a block on its own,
  // the shape of a short sharp drain herd. Replayed (30 windows): no roll without a brownout
  // passed 112 in a minute, and every brownout or herd peaked at 5,999 or more.
  nonDrain503Budget: {
    warnMultiple: 1.5,
    warnMarginPerMinute: 20,
    blockMultiple: 2,
    blockMarginPerMinute: 40,
    consecutiveMinutes: 2,
    spikeMultiple: 10,
    spikeFloor: 200
  },
  // A drain-return deferral tells the host when to come back; past a minute the drain is no
  // longer paced by the window but queued behind the director's lane.
  drainDeferral: { warnRetryAfterSecondsAbove: 30, blockRetryAfterSecondsAbove: 60 },
  cloudSqlFatal: { warnAbove: 0, blockAbove: 20 },
  // With no drain timestamp (a resumed rollback skips the drain) the window still has to start
  // somewhere; this is how far back of the verify end it reaches instead.
  fallbackWindowMinutes: 30,
  // A read that stalls must not be allowed to spend the job's remaining minutes.
  readTimeoutMs: 60_000,
  // Reads are serialised, so a failure mode that makes every read cost its full retry budget
  // (an expired credential, a Logging 429 storm) scales with the window, not with one read.
  // Past this the gate stops reading and reports the rest unverified, which is a verdict; the
  // step's own timeout-minutes sits above it and exists only for a hung process. Set well clear
  // of a healthy gate's own serial read time, or ordinary days report unverified tails and the
  // shadow roll stops measuring the thing it exists to measure. Raise both bounds together.
  overallDeadlineMs: 420_000
}

const MINUTE_MS = 60_000

export function parseTimestamp(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (Number.isNaN(parsed)) throw new Error(`${label} is not an RFC 3339 timestamp: ${value}`)
  return new Date(parsed)
}

export function formatTimestamp(date) {
  return `${date.toISOString().slice(0, 19)}Z`
}

/**
 * The window a cell's roll is judged over: its drain start to its verify end. A resumed rollback
 * never drains, so the apply start, then a fixed lookback, stands in for it.
 */
export function resolveWindow({
  drainStartedAt,
  applyStartedAt,
  verifyEndedAt,
  fallbackMinutes = SHADOW_GATE_THRESHOLDS.fallbackWindowMinutes
}) {
  const endedAt = parseTimestamp(verifyEndedAt, 'verify end')
  const start = drainStartedAt || applyStartedAt
  const startedAt = start
    ? parseTimestamp(start, 'window start')
    : new Date(endedAt.getTime() - fallbackMinutes * MINUTE_MS)
  if (startedAt >= endedAt) throw new Error('shadow gate window starts at or after it ends')
  return { startedAt, endedAt, startedFrom: drainStartedAt ? 'drain' : start ? 'apply' : 'fallback' }
}

export function splitWindow({ startedAt, endedAt }, minutes = SUB_WINDOW_MINUTES) {
  const step = minutes * MINUTE_MS
  const windows = []
  for (let cursor = startedAt.getTime(); cursor < endedAt.getTime(); cursor += step) {
    windows.push({
      startedAt: new Date(cursor),
      endedAt: new Date(Math.min(cursor + step, endedAt.getTime()))
    })
  }
  return windows
}

/**
 * Counts per clock minute across sub-window reads. A sub-window that returned exactly the entry
 * limit is truncated, so its minutes are floors, not counts, and the whole read is unverified.
 */
export function countByMinute(reads, limit = ENTRY_LIMIT) {
  const perMinute = new Map()
  let truncated = false
  for (const read of reads) {
    if (read.failed || read.timestamps.length >= limit) truncated = true
    for (const timestamp of read.timestamps) {
      const minute = timestamp.slice(0, 16)
      perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1)
    }
  }
  let peak = 0
  let peakMinute = null
  let total = 0
  for (const [minute, count] of perMinute) {
    total += count
    if (count > peak) {
      peak = count
      peakMinute = minute
    }
  }
  return { perMinute: Object.fromEntries(perMinute), total, peak, peakMinute, truncated }
}

// Longest run of consecutive samples at or above the threshold.
export function longestRunAtOrAbove(values, threshold) {
  let longest = 0
  let run = 0
  for (const value of values) {
    run = value > threshold ? run + 1 : 0
    if (run > longest) longest = run
  }
  return longest
}

// Director runtime metrics land every 30 s per instance and count the interval before the sample.
export const DIRECTOR_METRICS_INTERVAL_MS = 30_000

export function minuteKey(at) {
  return new Date(at).toISOString().slice(0, 16)
}

export function minutesOf({ startedAt, endedAt }) {
  const minutes = []
  const first = Math.floor(startedAt.getTime() / MINUTE_MS) * MINUTE_MS
  for (let cursor = first; cursor < endedAt.getTime(); cursor += MINUTE_MS) {
    minutes.push(minuteKey(cursor))
  }
  return minutes
}

// A host re-dialling inside its own retry interval, or while its last dial is still in flight. The
// drain-return lane already answers these with the per-host interval rather than a place in line;
// on 10-02 they were ~3/4 of background 503s and doubled with placement volume, drain or not.
const OWN_RETRY_REASONS = ['host-rate-limited', 'host-in-flight']

function ownRetries(sample) {
  return ['stickyRejectionsByReasonDelta', 'placementRejectionsByReasonDelta'].reduce(
    (sum, field) => sum + OWN_RETRY_REASONS.reduce(
      (count, reason) => count + (sample[field]?.[reason] ?? 0),
      0
    ),
    0
  )
}

// A drained host whose redial beats its own release meets its own row. That host was admitted to
// the drain-return lane first (the admission is counted before the assign that is refused), so
// row-busy refusals up to that minute's drain-return admissions are scheduled. Anything beyond is
// row contention the drain does not explain, and stays in the budget. The margin absorbs rounding
// from splitting each 30 s sample across clock minutes.
const ROW_BUSY_MARGIN_PER_MINUTE = 2

function rowBusy(sample) {
  return sample.assign503sByCauseDelta?.relay_assignment_row_busy ?? 0
}

/**
 * The director's scheduled 503s per clock minute, from its runtime-metrics samples: drain-return
 * deferrals and answers to a host's own early retry, plus the re-placements. Each sample's count is
 * split across the minutes its 30 s interval spans, in proportion, so a burst cannot land whole in
 * a neighbouring minute and cancel that minute's real 503s.
 */
export function drainReturnByMinute(reads, limit) {
  const deferrals = new Map()
  const retries = new Map()
  const busy = new Map()
  const assignments = new Map()
  let retryAfterSecondsMax = 0
  let truncated = false
  const charge = (map, endedAt, count) => {
    let cursor = endedAt - DIRECTOR_METRICS_INTERVAL_MS
    while (cursor < endedAt) {
      const next = Math.min(endedAt, (Math.floor(cursor / MINUTE_MS) + 1) * MINUTE_MS)
      const minute = minuteKey(cursor)
      map.set(minute, (map.get(minute) ?? 0) + count * (next - cursor) / DIRECTOR_METRICS_INTERVAL_MS)
      cursor = next
    }
  }
  for (const read of reads) {
    // The director always runs, so a read short of one instance's samples is a short answer (a
    // Logging 429 can return one), not a quiet minute.
    if (read.failed || read.samples.length >= limit || read.samples.length < (read.minSamples ?? 0)) {
      truncated = true
    }
    for (const sample of read.samples) {
      const endedAt = Date.parse(sample.timestamp)
      charge(deferrals, endedAt, sample.drainReturnDeferralsDelta ?? 0)
      charge(retries, endedAt, ownRetries(sample))
      charge(busy, endedAt, rowBusy(sample))
      charge(assignments, endedAt, sample.drainReturnAssignmentsDelta ?? 0)
      retryAfterSecondsMax = Math.max(
        retryAfterSecondsMax,
        sample.drainReturnRetryAfterSecondsMax ?? 0
      )
    }
  }
  const sum = (map) => Math.round([...map.values()].reduce((total, count) => total + count, 0))
  let rowBusyBeyondDrain = 0
  for (const [minute, count] of busy) {
    const scheduled = Math.min(count, (assignments.get(minute) ?? 0) + ROW_BUSY_MARGIN_PER_MINUTE)
    rowBusyBeyondDrain += count - scheduled
    retries.set(minute, (retries.get(minute) ?? 0) + scheduled)
  }
  return {
    deferralsPerMinute: Object.fromEntries(deferrals),
    ownRetriesPerMinute: Object.fromEntries(retries),
    deferralsTotal: sum(deferrals),
    deferralsPeakPerMinute: Math.round(Math.max(0, ...deferrals.values())),
    assignmentsTotal: sum(assignments),
    assignmentsPeakPerMinute: Math.round(Math.max(0, ...assignments.values())),
    rowBusyBeyondDrainTotal: Math.round(rowBusyBeyondDrain),
    retryAfterSecondsMax,
    truncated
  }
}

/**
 * Director 503s per minute over the given minutes, with the scheduled ones taken out. A deferral or
 * an early-retry answer tells one host when to come back, so a faster drain multiplies them without
 * anything being wrong; what is left is lanes, capacity, and the database refusing work.
 */
export function withoutDrainDeferrals({ perMinute, failed }, drain, minutes) {
  const series = minutes.map((minute) => Math.max(
    0,
    Math.round(
      (perMinute[minute] ?? 0) -
      (drain.deferralsPerMinute[minute] ?? 0) -
      (drain.ownRetriesPerMinute?.[minute] ?? 0)
    )
  ))
  const peak = Math.max(0, ...series)
  return {
    minutes,
    series,
    total: series.reduce((sum, count) => sum + count, 0),
    peak,
    peakMinute: peak > 0 ? minutes[series.indexOf(peak)] : null,
    allPeak: Math.max(0, ...minutes.map((minute) => perMinute[minute] ?? 0)),
    drainDeferralsTotal: Math.round(
      minutes.reduce((sum, minute) => sum + (drain.deferralsPerMinute[minute] ?? 0), 0)
    ),
    ownRetriesTotal: Math.round(
      minutes.reduce((sum, minute) => sum + (drain.ownRetriesPerMinute?.[minute] ?? 0), 0)
    ),
    unverified: Boolean(failed) || drain.truncated
  }
}

// The middle minute of the same-day minutes before the drain: a busy morning raises it with the
// window, and one incident minute inside it does not.
export function backgroundOf(nonDrain) {
  const sorted = [...nonDrain.series].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length === 0
    ? 0
    : sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  return {
    startedAt: nonDrain.minutes[0] ?? null,
    minutes: nonDrain.minutes.length,
    medianPerMinute: median,
    perMinute: nonDrain.series,
    unverified: nonDrain.unverified || nonDrain.minutes.length === 0
  }
}

export function judgeNonDrain503Budget({ observed, background }) {
  const {
    warnMultiple,
    warnMarginPerMinute,
    blockMultiple,
    blockMarginPerMinute,
    consecutiveMinutes,
    spikeMultiple,
    spikeFloor
  } = SHADOW_GATE_THRESHOLDS.nonDrain503Budget
  const perMinute = background.medianPerMinute
  const warnAbove = Math.max(perMinute * warnMultiple, perMinute + warnMarginPerMinute)
  const blockAbove = Math.max(perMinute * blockMultiple, perMinute + blockMarginPerMinute)
  const detail = {
    backgroundPerMinute: perMinute,
    peakPerMinute: observed.peak,
    peakMinute: observed.peakMinute,
    // The raw count and what was taken out of it, so the subtraction can be checked by hand.
    allPeakPerMinute: observed.allPeak,
    drainDeferralsTotal: observed.drainDeferralsTotal,
    ownRetriesTotal: observed.ownRetriesTotal,
    warnAbove,
    blockAbove,
    spikeAbove: Math.max(perMinute * spikeMultiple, spikeFloor),
    consecutiveMinutesOverWarn: longestRunAtOrAbove(observed.series, warnAbove),
    consecutiveMinutesOverBlock: longestRunAtOrAbove(observed.series, blockAbove),
    // The record a ladder rung keeps: non-drain 503s per minute from the drain start.
    perMinute: observed.series
  }
  if (observed.unverified || background.unverified) return { status: 'unverified', ...detail }
  if (
    detail.consecutiveMinutesOverBlock >= consecutiveMinutes ||
    observed.peak > detail.spikeAbove
  ) return { status: 'would-block', ...detail }
  if (detail.consecutiveMinutesOverWarn >= consecutiveMinutes) return { status: 'warn', ...detail }
  return { status: 'pass', ...detail }
}

export function judgeDrainDeferrals(drain) {
  const { warnRetryAfterSecondsAbove, blockRetryAfterSecondsAbove } =
    SHADOW_GATE_THRESHOLDS.drainDeferral
  const detail = {
    deferralsTotal: drain.deferralsTotal,
    deferralsPeakPerMinute: drain.deferralsPeakPerMinute,
    // The measured drain rate: re-placements the director's drain-return lane admitted.
    replacementsTotal: drain.assignmentsTotal,
    replacementsPeakPerMinute: drain.assignmentsPeakPerMinute,
    retryAfterSecondsMax: drain.retryAfterSecondsMax,
    warnAbove: warnRetryAfterSecondsAbove,
    blockAbove: blockRetryAfterSecondsAbove
  }
  if (drain.truncated) return { status: 'unverified', ...detail }
  if (drain.retryAfterSecondsMax > blockRetryAfterSecondsAbove) {
    return { status: 'would-block', ...detail }
  }
  if (drain.retryAfterSecondsMax > warnRetryAfterSecondsAbove) {
    return { status: 'warn', ...detail }
  }
  return { status: 'pass', ...detail }
}


/**
 * The cell's own container: it has to have announced its listener since the apply began, and it
 * must not have crashed anywhere in that span. Counting crashes only after the *last* listener
 * would erase a crash-restart loop, whose later announcement looks like a clean boot; the MIG
 * recreates the instance, so everything on this instance id since the apply belongs to this roll.
 *
 * A missing announcement only means a failure where a restart was expected. A resumed rollback
 * deliberately restarts nothing, so there is no boot for this oracle to observe and its silence
 * says nothing either way.
 */
export function judgeCellServing({ listeningAt, crashesSinceApply, read, expectBoot = true }) {
  const detail = {
    listeningAt: listeningAt ?? null,
    crashesSinceApply: crashesSinceApply ?? 0,
    expectBoot
  }
  if (read?.failed) return { status: 'unverified', ...detail }
  if (!listeningAt) return { status: expectBoot ? 'would-block' : 'unverified', ...detail }
  if (detail.crashesSinceApply > 0) return { status: 'would-block', ...detail }
  return { status: 'pass', ...detail }
}

/**
 * Pool pressure. A single spike is a burst the pool absorbs; the block rule needs the pressure to
 * persist across consecutive samples, which is what separates it from the one-sample false
 * positives a literal rule produced this week.
 */
export function judgePool({ label, samples, failed = false, truncated = false }) {
  const { waitersMax, waitersConsecutiveSamples, sqlFailuresDelta } = SHADOW_GATE_THRESHOLDS.pool
  const waiters = samples.map((sample) => sample.databasePoolWaitersMax ?? 0)
  const failures = samples.map((sample) => sample.sqlFailuresDelta ?? 0)
  const detail = {
    label,
    samples: samples.length,
    waitersMax: Math.max(0, ...waiters),
    consecutiveSamplesOverWaitersThreshold: longestRunAtOrAbove(waiters, waitersMax),
    sqlFailuresDeltaMax: Math.max(0, ...failures),
    reconnectsDeltaMax: Math.max(0, ...samples.map((sample) => sample.reconnectsDelta ?? 0)),
    totalConnectionsMax: Math.max(0, ...samples.map((sample) => sample.totalConnections ?? 0)),
    databasePoolWaitingMax: Math.max(0, ...samples.map((sample) => sample.databasePoolWaiting ?? 0)),
    waitersThreshold: waitersMax,
    consecutiveSamplesThreshold: waitersConsecutiveSamples,
    sqlFailuresDeltaThreshold: sqlFailuresDelta,
    truncated
  }
  // A sample over the failure line is a fact however many others are missing.
  if (detail.sqlFailuresDeltaMax > sqlFailuresDelta) return { status: 'would-block', ...detail }
  // A truncated sample run has holes, and the consecutive-sample rule reads a hole as a recovery
  // (or joins two runs across one), so it is judged only on a complete run.
  if (failed || truncated || samples.length === 0) return { status: 'unverified', ...detail }
  if (detail.consecutiveSamplesOverWaitersThreshold >= waitersConsecutiveSamples) {
    return { status: 'would-block', ...detail }
  }
  if (detail.waitersMax > waitersMax) return { status: 'warn', ...detail }
  return { status: 'pass', ...detail }
}

export function judgeCloudSqlFatal({ count, truncated = false, failed = false }) {
  const { warnAbove, blockAbove } = SHADOW_GATE_THRESHOLDS.cloudSqlFatal
  const detail = { count, warnAbove, blockAbove }
  // A truncated count is a lower bound: already over the line is a block, under it proves nothing.
  if (count > blockAbove) return { status: 'would-block', ...detail }
  if (failed || truncated) return { status: 'unverified', ...detail }
  if (count > warnAbove) return { status: 'warn', ...detail }
  return { status: 'pass', ...detail }
}

// The checks a drain pace can move. The rest (Cloud SQL, the Asia pools, the new boot) read the
// fleet or the image, so a clean roll at any pace can still WARN on them.
export const PACE_CHECKS = ['nonDrain503Budget', 'drainDeferrals']

export function combineVerdict(checks) {
  const statuses = Object.values(checks).map((check) => check.status)
  if (statuses.includes('would-block')) return VERDICTS.WOULD_BLOCK
  if (statuses.includes('unverified') || statuses.includes('warn')) return VERDICTS.WARN
  return VERDICTS.PASS
}

export function renderStepSummary(report) {
  const rows = Object.entries(report.checks).map(([name, check]) => {
    const numbers = Object.entries(check)
      .filter(([key, value]) => key !== 'status' && value !== null && typeof value !== 'object')
      .map(([key, value]) => `${key}=${value}`)
      .join(', ')
    return `| ${name} | ${check.status} | ${numbers} |`
  })
  return [
    `## Shadow health gate (report only): ${report.verdict} (pace checks: ${report.paceVerdict})`,
    '',
    `Cell \`${report.cellId}\`, window ${report.window.startedAt} to ${report.window.endedAt}`,
    `(start taken from: ${report.window.startedFrom}).`,
    `Drain pace ${report.drain.paceWindowMs} ms (cell applied: ` +
      `${report.drain.appliedPaceWindowMs ?? 'not drained'}), ` +
      `${report.drain.targetHosts ?? 'unknown'} hosts, settled ${report.drain.settledAt ?? 'never'}.`,
    'This gate never fails the job. Compare its verdict with the operator call for this cell.',
    '',
    '| check | status | numbers |',
    '| --- | --- | --- |',
    ...rows,
    ''
  ].join('\n')
}
