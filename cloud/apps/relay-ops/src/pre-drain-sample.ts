import {
  describeIncidentFailure,
  evaluateIncidentSample,
  FRESHNESS_FAILURE_CODES,
  INCIDENT_FRESHNESS_TOLERANCE_SAMPLES,
  INCIDENT_MONITOR_THRESHOLDS,
  toleratedStreakKey,
  type IncidentFailure,
  type IncidentSample
} from './incident-monitor.js'

// Inline fleet-health sample a same-cap wave takes right before it isolates its cell. It judges
// every sample with the monitor's own evaluator and tolerances; what it adds is a window sized to
// the drain and three lookback rules no single sample can see.

export const PRE_DRAIN_SAMPLE_INTERVAL_MS = 60_000

// A bigger drain re-places more hosts through the director's single sticky lane, so it gets a
// longer quiet window before it starts. Ordered; the first band whose ceiling covers the cell wins.
export const PRE_DRAIN_SAMPLE_WINDOWS = [
  { maxHosts: 500, minutes: 3 },
  { maxHosts: 1_500, minutes: 5 },
  { maxHosts: Number.POSITIVE_INFINITY, minutes: 8 }
] as const

export const PRE_DRAIN_HARD_RULES = {
  // Any container exit on a cell that takes placements, other than the cell being rolled; a drain
  // into a crash loop re-places its hosts twice.
  cellProcessExitLookbackMs: 10 * 60_000,
  cellProcessExitsMax: 0,
  // A disconnect pulse lands as thousands of director 503s in one minute (7,750 and 13,000 on
  // 2026-09-20 and 2026-10-01) against a healthy 20-70.
  director503LookbackMs: 10 * 60_000,
  director503PerMinuteMax: 500,
  // The live preflight reads only the newest concurrency point; this holds the last four minutes.
  directorConcurrencyLookbackMs: 4 * 60_000,
  directorConcurrencyP99Max: INCIDENT_MONITOR_THRESHOLDS.directorConcurrency
} as const

export type PreDrainHardRuleReadings = {
  // Exits on general or migration-only cells other than the target.
  cellProcessExits: number
  // Exits on an instance no cell could be resolved for; never assumed harmless.
  unattributedExitInstances: string[]
  director503PeakPerMinute: number
  // Null when Cloud Monitoring published no point in the lookback.
  directorConcurrencyP99: number | null
}

// Which exits count. The target's own exits are why it is being rolled (c25 crashed 12 times in
// a week and is the first US roll), and existing-only legacy cells take no placements (c5 alone
// exited 15 times in that week), so neither can stop a drain. An instance with no known cell
// counts as unattributed and trips the rule.
export function attributeCellExits(input: {
  exitsByInstance: ReadonlyMap<string, number>
  cellByInstance: ReadonlyMap<string, string | null>
  targetCellId: string
  placementCellIds: ReadonlySet<string>
  configuredCellIds: ReadonlySet<string>
}): { counted: number; unattributed: string[] } {
  let counted = 0
  const unattributed: string[] = []
  for (const [instanceId, exits] of input.exitsByInstance) {
    if (exits <= 0) continue
    const cellId = input.cellByInstance.get(instanceId) ?? null
    if (cellId === null || !input.configuredCellIds.has(cellId)) {
      unattributed.push(instanceId)
      continue
    }
    if (cellId === input.targetCellId || !input.placementCellIds.has(cellId)) continue
    counted += exits
  }
  return { counted, unattributed: unattributed.sort() }
}

export function preDrainSampleWindowMinutes(hostCount: number): number {
  if (!Number.isSafeInteger(hostCount) || hostCount < 0) {
    throw new Error('pre-drain sample host count is invalid')
  }
  const band = PRE_DRAIN_SAMPLE_WINDOWS.find((entry) => hostCount <= entry.maxHosts)
  if (!band) throw new Error('pre-drain sample host count is invalid')
  return band.minutes
}

export function evaluatePreDrainHardRules(readings: PreDrainHardRuleReadings): IncidentFailure[] {
  const failures: IncidentFailure[] = []
  if (readings.cellProcessExits > PRE_DRAIN_HARD_RULES.cellProcessExitsMax) {
    failures.push({
      code: 'threshold_max',
      source: 'cloud-monitoring',
      signal: 'cells.process_exits_10m',
      observed: readings.cellProcessExits,
      threshold: PRE_DRAIN_HARD_RULES.cellProcessExitsMax
    })
  }
  if (readings.unattributedExitInstances.length > 0) {
    failures.push({
      code: 'exit_unattributed',
      source: 'cloud-monitoring',
      signal: `cells.process_exits_10m.instances=${readings.unattributedExitInstances.join('+')}`,
      observed: readings.unattributedExitInstances.length,
      threshold: 0
    })
  }
  if (readings.director503PeakPerMinute > PRE_DRAIN_HARD_RULES.director503PerMinuteMax) {
    failures.push({
      code: 'threshold_max',
      source: 'cloud-monitoring',
      signal: 'director.503_peak_minute_10m',
      observed: readings.director503PeakPerMinute,
      threshold: PRE_DRAIN_HARD_RULES.director503PerMinuteMax
    })
  }
  if (readings.directorConcurrencyP99 === null) {
    failures.push({
      code: 'signal_missing',
      source: 'cloud-monitoring',
      signal: 'director.concurrency_p99_4m'
    })
  } else if (readings.directorConcurrencyP99 > PRE_DRAIN_HARD_RULES.directorConcurrencyP99Max) {
    failures.push({
      code: 'threshold_max',
      source: 'cloud-monitoring',
      signal: 'director.concurrency_p99_4m',
      observed: readings.directorConcurrencyP99,
      threshold: PRE_DRAIN_HARD_RULES.directorConcurrencyP99Max
    })
  }
  return failures
}

export type PreDrainSampleRecord = {
  at: string
  failures: IncidentFailure[]
  // Why a read failed; a failure code alone hides a permission error or a bad filter.
  errors: string[]
}

// Samples past the window that may still carry a tolerated failure; alternating tolerated readings
// (cell X, then cell Y) never trip a streak, so this is what bounds the overrun.
export const PRE_DRAIN_MAX_OVERRUN_SAMPLES = INCIDENT_FRESHNESS_TOLERANCE_SAMPLES + 1

export type PreDrainSampleResult = {
  windowMinutes: number
  startedAt: string
  completedAt: string
  samples: PreDrainSampleRecord[]
}

export class PreDrainSampleTripped extends Error {
  constructor(readonly failures: IncidentFailure[], readonly samples: PreDrainSampleRecord[]) {
    super(`relay pre-drain sample tripped: ${failures.map(describeIncidentFailure).join(',')}`)
  }
}

const CONTINUITY_CODES = new Set(['collector_failed', ...FRESHNESS_FAILURE_CODES])

function continuityKey(failure: IncidentFailure): string {
  return `${failure.source}/${failure.signal ?? '*'}`
}

function bumpStreaks(streaks: Map<string, number>, keys: Set<string>): Map<string, number> {
  const next = new Map<string, number>()
  for (const key of keys) next.set(key, (streaks.get(key) ?? 0) + 1)
  return next
}

/**
 * Samples once a minute until the window has elapsed, then keeps going until a sample comes back
 * with no failure at all, so the drain never starts on an open reading. A breach of any
 * non-tolerated threshold or hard rule trips at once; readings the monitor tolerates (a cell probe
 * or the director instance count, an unread signal, a failed collector round trip) trip only past
 * the monitor's own consecutive-sample budget. The overrun is capped separately.
 */
export async function runPreDrainSample(input: {
  windowMinutes: number
  collect: () => Promise<IncidentSample>
  readHardRules: () => Promise<PreDrainHardRuleReadings>
  now?: () => number
  wait?: (ms: number) => Promise<void>
  log?: (record: PreDrainSampleRecord) => void
}): Promise<PreDrainSampleResult> {
  if (!PRE_DRAIN_SAMPLE_WINDOWS.some((band) => band.minutes === input.windowMinutes)) {
    throw new Error('pre-drain sample window is invalid')
  }
  const now = input.now ?? Date.now
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolveWait) => {
    setTimeout(resolveWait, ms)
  }))
  const startedMs = now()
  const windowMs = input.windowMinutes * 60_000
  const samples: PreDrainSampleRecord[] = []
  let continuityStreaks = new Map<string, number>()
  let probeStreaks = new Map<string, number>()
  let overrunSamples = 0
  for (;;) {
    const sampleStartedMs = now()
    const failures: IncidentFailure[] = []
    const errors: string[] = []
    const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
    try {
      failures.push(
        ...evaluateIncidentSample(await input.collect(), now(), 'strict', null, null).failures
      )
    } catch (error) {
      failures.push({ code: 'collector_failed', source: 'cloud-monitoring' })
      errors.push(`collector: ${reason(error)}`)
    }
    try {
      failures.push(...evaluatePreDrainHardRules(await input.readHardRules()))
    } catch (error) {
      failures.push({
        code: 'collector_failed',
        source: 'cloud-monitoring',
        signal: 'pre-drain.hard-rules'
      })
      errors.push(`hard rules: ${reason(error)}`)
    }
    const record = { at: new Date(now()).toISOString(), failures, errors }
    samples.push(record)
    input.log?.(record)
    const continuity = failures.filter((failure) => CONTINUITY_CODES.has(failure.code))
    const breaches = failures.filter((failure) => !CONTINUITY_CODES.has(failure.code))
    continuityStreaks = bumpStreaks(continuityStreaks, new Set(continuity.map(continuityKey)))
    const probeKeys = new Set<string>()
    for (const failure of breaches) {
      const key = toleratedStreakKey(failure)
      if (key !== null) probeKeys.add(key)
    }
    probeStreaks = bumpStreaks(probeStreaks, probeKeys)
    const tripped = [
      ...breaches.filter((failure) => {
        const key = toleratedStreakKey(failure)
        return key === null ||
          (probeStreaks.get(key) ?? 0) > INCIDENT_MONITOR_THRESHOLDS.cellProbeToleranceSamples
      }),
      ...continuity.filter((failure) =>
        (continuityStreaks.get(continuityKey(failure)) ?? 0) >
          INCIDENT_FRESHNESS_TOLERANCE_SAMPLES)
    ]
    if (tripped.length > 0) throw new PreDrainSampleTripped(tripped, samples)
    const windowDone = now() - startedMs >= windowMs
    if (windowDone && failures.length > 0) {
      overrunSamples += 1
      if (overrunSamples > PRE_DRAIN_MAX_OVERRUN_SAMPLES) {
        throw new PreDrainSampleTripped(failures, samples)
      }
    }
    if (windowDone && failures.length === 0) {
      return {
        windowMinutes: input.windowMinutes,
        startedAt: new Date(startedMs).toISOString(),
        completedAt: record.at,
        samples
      }
    }
    await wait(Math.max(0, sampleStartedMs + PRE_DRAIN_SAMPLE_INTERVAL_MS - now()))
  }
}
