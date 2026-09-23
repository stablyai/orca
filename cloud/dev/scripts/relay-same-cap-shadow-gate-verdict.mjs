// Windowing, thresholds, and the verdict for the same-cap post-wave shadow health gate. Pure: it
// takes already-read log samples and returns a judgement, so every rule here is unit-testable
// without touching production. The reader lives in relay-same-cap-shadow-gate.mjs.

// Status vocabulary, worst-first. 'unverified' is a read that did not complete or that hit the
// entry limit; it can never settle to 'pass', because a truncated count is not evidence of calm.
export const CHECK_STATUSES = ['would-block', 'unverified', 'warn', 'pass']

export const VERDICTS = { PASS: 'PASS', WARN: 'WARN', WOULD_BLOCK: 'WOULD_BLOCK' }

// Cloud Logging silently returns only `--limit` entries, so every read is split into sub-windows
// this long and a sub-window that comes back exactly at the limit is reported as truncated.
export const SUB_WINDOW_MINUTES = 10

export const ENTRY_LIMIT = 20000

// Clock-hour-aligned comparisons: the same wall-clock minutes one and two days earlier.
export const BASELINE_OFFSET_HOURS = [24, 48]

// The asia-east2 cells share a 16-connection pool at 176 ms RTT, which is where pool pressure
// shows up first for the whole fleet. A cell joins only once it serves: zero samples read as
// unverified, so listing a not-yet-general cell would turn every verdict into WARN.
export const FLEET_POOL_CELL_IDS = [
  'production-gce-c27',
  'production-gce-c28',
  'production-gce-c29'
]

export const SHADOW_GATE_THRESHOLDS = {
  // A US ramp legitimately lifts director 503s far above a quiet baseline (61-71/min against a
  // 20-60/min baseline was healthy), so this is a multiple of the busier baseline with an
  // absolute floor underneath it, never a fixed rate.
  director503: { blockMultiple: 10, blockFloor: 200, warnMultiple: 3, warnFloor: 100 },
  // One sample at 71 waiters is a burst that drains; three in a row is a pool that does not.
  pool: { waitersMax: 50, waitersConsecutiveSamples: 3, sqlFailuresDelta: 200 },
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
const HOUR_MS = 3_600_000

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

export function shiftWindow({ startedAt, endedAt }, hours) {
  return {
    startedAt: new Date(startedAt.getTime() - hours * HOUR_MS),
    endedAt: new Date(endedAt.getTime() - hours * HOUR_MS)
  }
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

export function judgeDirector503({ observed, baselines }) {
  const { blockMultiple, blockFloor, warnMultiple, warnFloor } = SHADOW_GATE_THRESHOLDS.director503
  const baselinePeak = Math.max(0, ...baselines.map((baseline) => baseline.peak))
  const baselineTruncated = baselines.some((baseline) => baseline.truncated)
  const detail = {
    peakPerMinute: observed.peak,
    peakMinute: observed.peakMinute,
    total: observed.total,
    baselinePeakPerMinute: baselinePeak,
    baselines: baselines.map(({ label, peak, total, truncated }) => ({
      label,
      peakPerMinute: peak,
      total,
      truncated
    })),
    blockAbove: Math.max(baselinePeak * blockMultiple, blockFloor),
    warnAbove: Math.max(baselinePeak * warnMultiple, warnFloor)
  }
  if (observed.truncated || baselineTruncated) return { status: 'unverified', ...detail }
  if (observed.peak > detail.blockAbove) return { status: 'would-block', ...detail }
  if (observed.peak > detail.warnAbove) return { status: 'warn', ...detail }
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
  // A truncated sample run has holes, and the consecutive-sample rule reads a hole as a recovery.
  if (failed || truncated || samples.length === 0) return { status: 'unverified', ...detail }
  if (
    detail.consecutiveSamplesOverWaitersThreshold >= waitersConsecutiveSamples
    || detail.sqlFailuresDeltaMax > sqlFailuresDelta
  ) return { status: 'would-block', ...detail }
  if (detail.waitersMax > waitersMax) return { status: 'warn', ...detail }
  return { status: 'pass', ...detail }
}

export function judgeCloudSqlFatal({ count, truncated = false, failed = false }) {
  const { warnAbove, blockAbove } = SHADOW_GATE_THRESHOLDS.cloudSqlFatal
  const detail = { count, warnAbove, blockAbove }
  if (failed || truncated) return { status: 'unverified', ...detail }
  if (count > blockAbove) return { status: 'would-block', ...detail }
  if (count > warnAbove) return { status: 'warn', ...detail }
  return { status: 'pass', ...detail }
}

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
    `## Shadow health gate (report only): ${report.verdict}`,
    '',
    `Cell \`${report.cellId}\`, window ${report.window.startedAt} to ${report.window.endedAt}`,
    `(start taken from: ${report.window.startedFrom}).`,
    'This gate never fails the job. Compare its verdict with the operator call for this cell.',
    '',
    '| check | status | numbers |',
    '| --- | --- | --- |',
    ...rows,
    ''
  ].join('\n')
}
