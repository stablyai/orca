import {
  exactAdmissionSelector,
  type AdmissionSelector,
  type AdmissionState
} from './incident-selector.js'

export const INCIDENT_MONITOR_THRESHOLDS = {
  activeProbeMaxAgeMs: 60_000,
  cloudDataMaxAgeMs: 180_000,
  relayLogMaxAgeMs: 180_000,
  heartbeatMaxAgeMs: 45_000,
  endpointLatencyMs: 2_000,
  cloudSqlCpuUtilization: 0.8,
  cloudSqlMemoryUtilization: 0.9,
  // Why: healthy latest-sum backends idle near 100 but spike to 216 in 1-minute
  // bursts (~10 min/day exceeded the old bar of 160 on 2026-08-26, freezing a
  // pre-drain gate on baseline noise). 250 clears measured healthy peaks while
  // firing well before the verified 400-connection ceiling; pool-wait and
  // exhausted-retry signals keep their strict thresholds.
  cloudSqlBackends: 250,
  // Bound the observed recovery load; deadlocks remain zero-tolerance.
  cloudSqlLockWaits: 20,
  cloudSqlDeadlocks: 0,
  // Why: pool amplitude cannot discriminate the 2026-08-23 incident. Healthy
  // fleet-wide bursts reach 43 waiters / 2.03s waits several times an hour,
  // and a cell roll's reconnect surge peaks at 676 waiters, while the real
  // incident peaked at 356 waiters and never crossed 2.5s (waits cap ~2s
  // structurally). The old bars of 30/1000 froze pre-drain gates on baseline
  // noise (~17% per 15-minute window). Incident-class contention is caught by
  // the retry signals below at ~10x separation; these bars now fence only
  // genuinely unbounded queueing, which grows past both.
  relayPoolWaiting: 800,
  relayPoolWaitMs: 2_500,
  // Why: successful lock retries are the contention machinery working, not harm.
  // Healthy 2026-08-26 baseline bursts to 234/5min (26% of windows crossed the old
  // bar of 20, set unmeasured at the monitor's 2026-07-28 birth); the 2026-08-23
  // incident ran ~2,200-3,000/5min. 300 clears healthy bursts with ~10x incident
  // margin; relayPostgresRetryExhausted below stays at zero tolerance, so any
  // transaction that terminally fails still freezes the gate.
  relayPostgresRetries: 300,
  relayPostgresRetryExhausted: 0,
  // Why: public admission is a per-instance semaphore, so fleet assignment capacity is
  // concurrency x instances. A floor of 1 let the 2026-08-04 collapse from five instances
  // to two pass unnoticed, which is the exact failure this monitor exists to catch. Keep in
  // step with relay_min_instances in infra/terraform/environments/production.tfvars.
  directorInstancesMin: 5,
  // Five serving instances plus one warm scale-to-zero rollback during recovery.
  directorInstancesMax: 6,
  directorCpuUtilization: 0.8,
  directorMemoryUtilization: 0.8,
  directorConcurrency: 64,
  directorErrors: 0,
  authErrors: 0,
  // Why: 800 exceeded the 600 hard cap, so this could never trigger on a capped cell. 500 is
  // the ordinary admission limit a cell actually stops at (600 cap - 100 control-rebind reserve).
  cellConnections: 500,
  cellQueuedBytes: 48 * 1024 * 1024,
  migrationBlocked: 0
} as const

export const INCIDENT_CHECKPOINT_MINUTES = [0, 5, 15, 30, 45, 60, 75, 90] as const
export const INCIDENT_PRE_DRAIN_MAX_LINEAGE_MS = 25 * 60_000

export type IncidentSourceName =
  | 'active-probe'
  | 'cloud-monitoring'
  | 'relay-logs'
  | 'director-admin'

export type IncidentMigrationPolicy =
  | 'strict'
  | 'recover-forward'
  | 'capacity-transition'

export type IncidentSignal = {
  value: number
  observedAt: string
}

export type IncidentSource = {
  observedAt: string
  signals: Record<string, IncidentSignal>
}

export type IncidentCellExpectation = {
  cellId: string
  runtimeKnown: boolean
  powered: boolean
  expectedAdmissionState: AdmissionState
}

export type IncidentSample = {
  collectedAt: string
  selector: AdmissionSelector
  expectedSelector: AdmissionSelector
  sources: Partial<Record<IncidentSourceName, IncidentSource>>
  cells: IncidentCellExpectation[]
}

export type IncidentFailure = {
  code: string
  source: IncidentSourceName
  signal?: string
  observed?: number
  threshold?: number
}

export type IncidentEvaluation = {
  status: 'green' | 'freeze'
  evaluatedAt: string
  failures: IncidentFailure[]
}

export type IncidentCheckpoint = {
  schemaVersion: 4
  incidentId: string
  environment: 'production' | 'staging'
  expectedSelector: AdmissionSelector
  preDrainDryRun: boolean
  migrationPolicy: IncidentMigrationPolicy
  recoverySourceCellId: string | null
  capacityCellId: string | null
  windowSequence: number
  windowStartedAt: string
  checkpointMinute: number
  scheduledAt: string
  recordedAt: string
  status: 'green' | 'freeze'
  frozenAt: string | null
  sampleCount: number
  failures: IncidentFailure[]
  thresholds: typeof INCIDENT_MONITOR_THRESHOLDS
}

export type IncidentMonitorState = {
  schemaVersion: 4
  incidentId: string
  environment: 'production' | 'staging'
  expectedSelector: AdmissionSelector
  preDrainDryRun: boolean
  migrationPolicy: IncidentMigrationPolicy
  recoverySourceCellId: string | null
  capacityCellId: string | null
  startedAt: string
  windowStartedAt: string | null
  windowSequence: number
  durationMinutes: number
  intervalMs: number
  nextCheckpointIndex: number
  sampleCount: number
  totalSampleCount: number
  lastSampleAt: string | null
  continuityEvents: {
    recordedAt: string
    windowSequence: number
    failures: IncidentFailure[]
  }[]
  frozenAt: string | null
  failures: IncidentFailure[]
  completedAt: string | null
}

type NumericRule = {
  source: IncidentSourceName
  signal: string
  comparison: 'max' | 'min' | 'equal'
  threshold: number
}

const NUMERIC_RULES: NumericRule[] = [
  { source: 'active-probe', signal: 'director.health', comparison: 'equal', threshold: 1 },
  { source: 'active-probe', signal: 'director.ready', comparison: 'equal', threshold: 1 },
  {
    source: 'active-probe',
    signal: 'director.latency_ms',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.endpointLatencyMs
  },
  { source: 'active-probe', signal: 'auth.health', comparison: 'equal', threshold: 1 },
  {
    source: 'active-probe',
    signal: 'auth.latency_ms',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.endpointLatencyMs
  },
  {
    source: 'cloud-monitoring',
    signal: 'cloud_sql.cpu',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.cloudSqlCpuUtilization
  },
  {
    source: 'cloud-monitoring',
    signal: 'cloud_sql.memory',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.cloudSqlMemoryUtilization
  },
  {
    source: 'cloud-monitoring',
    signal: 'cloud_sql.backends',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.cloudSqlBackends
  },
  {
    source: 'cloud-monitoring',
    signal: 'director.instances',
    comparison: 'min',
    threshold: INCIDENT_MONITOR_THRESHOLDS.directorInstancesMin
  },
  {
    source: 'cloud-monitoring',
    signal: 'director.instances',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.directorInstancesMax
  },
  {
    source: 'cloud-monitoring',
    signal: 'director.cpu',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.directorCpuUtilization
  },
  {
    source: 'cloud-monitoring',
    signal: 'director.memory',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.directorMemoryUtilization
  },
  {
    source: 'cloud-monitoring',
    signal: 'director.concurrency',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.directorConcurrency
  },
  {
    source: 'cloud-monitoring',
    signal: 'director.errors',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.directorErrors
  },
  {
    source: 'cloud-monitoring',
    signal: 'auth.errors',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.authErrors
  },
  {
    source: 'cloud-monitoring',
    signal: 'cloud_sql.lock_waits',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.cloudSqlLockWaits
  },
  {
    source: 'cloud-monitoring',
    signal: 'cloud_sql.deadlocks',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.cloudSqlDeadlocks
  },
  {
    source: 'relay-logs',
    signal: 'relay.pool_waiting',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.relayPoolWaiting
  },
  {
    source: 'relay-logs',
    signal: 'relay.pool_wait_ms',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.relayPoolWaitMs
  },
  {
    source: 'relay-logs',
    signal: 'relay.postgres_retries',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.relayPostgresRetries
  },
  {
    source: 'relay-logs',
    signal: 'relay.postgres_retry_exhausted',
    comparison: 'max',
    threshold: INCIDENT_MONITOR_THRESHOLDS.relayPostgresRetryExhausted
  }
]

const SOURCE_MAX_AGE: Record<IncidentSourceName, number> = {
  'active-probe': INCIDENT_MONITOR_THRESHOLDS.activeProbeMaxAgeMs,
  'cloud-monitoring': INCIDENT_MONITOR_THRESHOLDS.cloudDataMaxAgeMs,
  'relay-logs': INCIDENT_MONITOR_THRESHOLDS.relayLogMaxAgeMs,
  'director-admin': INCIDENT_MONITOR_THRESHOLDS.cloudDataMaxAgeMs
}

function ageMs(timestamp: string, nowMs: number): number {
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? nowMs - parsed : Number.POSITIVE_INFINITY
}

function addMissingSignal(
  failures: IncidentFailure[],
  source: IncidentSourceName,
  signal: string
): void {
  failures.push({ code: 'signal_missing', source, signal })
}

function checkRule(
  failures: IncidentFailure[],
  source: IncidentSourceName,
  signals: Record<string, IncidentSignal>,
  rule: NumericRule
): void {
  const signal = signals[rule.signal]
  if (!signal) return addMissingSignal(failures, source, rule.signal)
  const failed =
    (rule.comparison === 'max' && signal.value > rule.threshold) ||
    (rule.comparison === 'min' && signal.value < rule.threshold) ||
    (rule.comparison === 'equal' && signal.value !== rule.threshold)
  if (failed) {
    failures.push({
      code: `threshold_${rule.comparison}`,
      source,
      signal: rule.signal,
      observed: signal.value,
      threshold: rule.threshold
    })
  }
}

function checkCell(
  failures: IncidentFailure[],
  sample: IncidentSample,
  cell: IncidentCellExpectation,
  migrationPolicy: IncidentMigrationPolicy,
  recoverySourceCellId: string | null,
  capacityCellId: string | null
): void {
  const probe = sample.sources['active-probe']?.signals
  const relay = sample.sources['relay-logs']?.signals
  const admin = sample.sources['director-admin']?.signals
  if (!cell.runtimeKnown) {
    failures.push({
      code: 'runtime_power_unknown',
      source: 'cloud-monitoring',
      signal: `cell.${cell.cellId}.powered`
    })
  }
  if (
    cell.runtimeKnown &&
    cell.expectedAdmissionState !== 'existing-only' &&
    !cell.powered
  ) {
    failures.push({
      code: 'expected_admission_without_runtime',
      source: 'director-admin',
      signal: `cell.${cell.cellId}.powered`,
      observed: 0,
      threshold: 1
    })
  }
  const checks = [
    ['active-probe', probe, `cell.${cell.cellId}.health`, cell.powered ? 1 : 0, 'equal'],
    ['active-probe', probe, `cell.${cell.cellId}.ready`, cell.powered ? 1 : 0, 'equal'],
    [
      'active-probe',
      probe,
      `cell.${cell.cellId}.latency_ms`,
      INCIDENT_MONITOR_THRESHOLDS.endpointLatencyMs,
      'max'
    ],
    [
      'director-admin',
      admin,
      `cell.${cell.cellId}.admission_state`,
      ['existing-only', 'migration-only', 'general'].indexOf(
        cell.expectedAdmissionState
      ),
      'equal'
    ],
    [
      'director-admin',
      admin,
      `cell.${cell.cellId}.heartbeat_fresh`,
      1,
      'equal'
    ],
    [
      'director-admin',
      admin,
      `cell.${cell.cellId}.heartbeat_age_ms`,
      INCIDENT_MONITOR_THRESHOLDS.heartbeatMaxAgeMs,
      'max'
    ],
    [
      'director-admin',
      admin,
      `cell.${cell.cellId}.migration_blocked`,
      INCIDENT_MONITOR_THRESHOLDS.migrationBlocked,
      'max'
    ],
    [
      'director-admin',
      admin,
      `cell.${cell.cellId}.migration_target_inactive`,
      INCIDENT_MONITOR_THRESHOLDS.migrationBlocked,
      'max'
    ],
    [
      'relay-logs',
      relay,
      `cell.${cell.cellId}.connections`,
      (admin?.[`cell.${cell.cellId}.connection_hard_cap`]?.value ??
        INCIDENT_MONITOR_THRESHOLDS.cellConnections + 1) - 1,
      'max'
    ],
    [
      'relay-logs',
      relay,
      `cell.${cell.cellId}.queued_bytes`,
      INCIDENT_MONITOR_THRESHOLDS.cellQueuedBytes,
      'max'
    ]
  ] as const
  for (const [source, signals, signalName, threshold, comparison] of checks) {
    if (
      migrationPolicy === 'recover-forward' &&
      cell.cellId === recoverySourceCellId &&
      signalName.endsWith('.migration_target_inactive')
    ) {
      if (!signals?.[signalName]) addMissingSignal(failures, source, signalName)
      continue
    }
    if (
      migrationPolicy === 'capacity-transition' &&
      capacityCellId !== null &&
      cell.cellId !== capacityCellId &&
      cell.expectedAdmissionState === 'existing-only' &&
      signalName.endsWith('.migration_target_inactive')
    ) {
      if (!signals?.[signalName]) addMissingSignal(failures, source, signalName)
      continue
    }
    if (
      cell.expectedAdmissionState === 'existing-only' &&
      signalName.endsWith('.connections')
    ) {
      continue
    }
    if (
      !cell.powered &&
      [
        'latency_ms',
        'heartbeat_fresh',
        'heartbeat_age_ms',
        'connections',
        'queued_bytes'
      ].some((suffix) => signalName.endsWith(suffix))
    ) {
      continue
    }
    if (!signals?.[signalName]) {
      addMissingSignal(failures, source, signalName)
      continue
    }
    const value = signals[signalName].value
    const failed = comparison === 'equal' ? value !== threshold : value > threshold
    if (failed) {
      failures.push({
        code: `threshold_${comparison}`,
        source,
        signal: signalName,
        observed: value,
        threshold
      })
    }
  }
}

export function evaluateIncidentSample(
  sample: IncidentSample,
  nowMs = Date.now(),
  migrationPolicy: IncidentMigrationPolicy = 'strict',
  recoverySourceCellId: string | null = null,
  capacityCellId: string | null = null
): IncidentEvaluation {
  const failures: IncidentFailure[] = []
  if (!exactAdmissionSelector(sample.selector, sample.expectedSelector)) {
    failures.push({
      code: 'selector_mismatch',
      source: 'director-admin',
      signal: 'selector.generation',
      observed: sample.selector.generation,
      threshold: sample.expectedSelector.generation
    })
  }
  for (const [sourceName, maxAge] of Object.entries(SOURCE_MAX_AGE) as [
    IncidentSourceName,
    number
  ][]) {
    const source = sample.sources[sourceName]
    if (!source) {
      failures.push({ code: 'source_missing', source: sourceName })
      continue
    }
    if (ageMs(source.observedAt, nowMs) < 0 || ageMs(source.observedAt, nowMs) > maxAge) {
      failures.push({
        code: 'source_stale',
        source: sourceName,
        observed: ageMs(source.observedAt, nowMs),
        threshold: maxAge
      })
    }
    for (const [signalName, signal] of Object.entries(source.signals)) {
      if (ageMs(signal.observedAt, nowMs) < 0 || ageMs(signal.observedAt, nowMs) > maxAge) {
        failures.push({
          code: 'signal_stale',
          source: sourceName,
          signal: signalName,
          observed: ageMs(signal.observedAt, nowMs),
          threshold: maxAge
        })
      }
    }
  }
  for (const rule of NUMERIC_RULES) {
    const source = sample.sources[rule.source]
    if (source) checkRule(failures, rule.source, source.signals, rule)
  }
  for (const cell of sample.cells) {
    checkCell(
      failures,
      sample,
      cell,
      migrationPolicy,
      recoverySourceCellId,
      capacityCellId
    )
  }
  return {
    status: failures.length === 0 ? 'green' : 'freeze',
    evaluatedAt: new Date(nowMs).toISOString(),
    failures
  }
}

export function initialIncidentMonitorState(input: {
  incidentId: string
  environment: 'production' | 'staging'
  expectedSelector: AdmissionSelector
  preDrainDryRun: boolean
  migrationPolicy: IncidentMigrationPolicy
  recoverySourceCellId: string | null
  capacityCellId: string | null
  startedAt: string
  durationMinutes: number
  intervalMs: number
}): IncidentMonitorState {
  if (input.intervalMs < 1_000 || input.intervalMs > 60_000) {
    throw new Error('incident monitor interval must be between 1 and 60 seconds')
  }
  if (input.durationMinutes < 15 || input.durationMinutes > 90) {
    throw new Error('incident monitor duration must be between 15 and 90 minutes')
  }
  return {
    schemaVersion: 4,
    ...input,
    windowStartedAt: input.startedAt,
    windowSequence: 0,
    nextCheckpointIndex: 0,
    sampleCount: 0,
    totalSampleCount: 0,
    lastSampleAt: null,
    continuityEvents: [],
    frozenAt: null,
    failures: [],
    completedAt: null
  }
}

export type IncidentMonitorDependencies = {
  now(): number
  wait(ms: number): Promise<void>
  collect(): Promise<IncidentSample>
  persist(state: IncidentMonitorState): Promise<void>
  checkpoint(summary: IncidentCheckpoint): Promise<void>
}

function checkpointMinutes(durationMinutes: number): number[] {
  return INCIDENT_CHECKPOINT_MINUTES.filter((minute) => minute <= durationMinutes)
}

const CONTINUITY_FAILURE_CODES = new Set([
  'collector_failed',
  'monitor_gap',
  'signal_stale',
  'source_missing',
  'source_stale'
])

function resetContinuousWindow(
  state: IncidentMonitorState,
  recordedAt: string,
  failures: IncidentFailure[]
): void {
  if (state.windowStartedAt !== null) {
    state.windowSequence++
    state.windowStartedAt = null
    state.nextCheckpointIndex = 0
    state.sampleCount = 0
    state.completedAt = null
  }
  state.continuityEvents.push({
    recordedAt,
    windowSequence: state.windowSequence,
    failures
  })
}

function completeContinuityDeadline(
  state: IncidentMonitorState,
  nowMs: number,
  lineageStartMs: number
): void {
  const recordedAt = new Date(nowMs).toISOString()
  state.frozenAt ??= recordedAt
  state.failures.push({
    code: 'continuity_deadline_exceeded',
    source: 'active-probe',
    observed: nowMs - lineageStartMs,
    threshold: INCIDENT_PRE_DRAIN_MAX_LINEAGE_MS
  })
  state.completedAt = recordedAt
}

export async function runIncidentMonitor(
  initialState: IncidentMonitorState,
  dependencies: IncidentMonitorDependencies
): Promise<IncidentMonitorState> {
  const state = structuredClone(initialState)
  const lineageStartMs = Date.parse(state.startedAt)
  if (!Number.isFinite(lineageStartMs)) {
    throw new Error('incident monitor start time is invalid')
  }
  const checkpoints = checkpointMinutes(state.durationMinutes)
  const lineageDeadlineMs = state.preDrainDryRun
    ? lineageStartMs + INCIDENT_PRE_DRAIN_MAX_LINEAGE_MS
    : Number.POSITIVE_INFINITY
  const resumedAt = dependencies.now()
  const priorSampleMs = state.lastSampleAt
    ? Date.parse(state.lastSampleAt)
    : lineageStartMs
  const gapThreshold = state.intervalMs
  if (resumedAt - priorSampleMs > gapThreshold) {
    resetContinuousWindow(state, new Date(resumedAt).toISOString(), [{
      code: 'monitor_gap',
      source: 'active-probe',
      observed: resumedAt - priorSampleMs,
      threshold: gapThreshold
    }])
  }
  if (state.completedAt !== null) {
    await dependencies.persist(state)
    return state
  }
  while (state.completedAt === null) {
    if (dependencies.now() > lineageDeadlineMs) {
      completeContinuityDeadline(state, dependencies.now(), lineageStartMs)
      await dependencies.persist(state)
      break
    }
    const sampleStartedAt = dependencies.now()
    let evaluation: IncidentEvaluation
    try {
      evaluation = evaluateIncidentSample(
        await dependencies.collect(),
        dependencies.now(),
        state.migrationPolicy,
        state.recoverySourceCellId,
        state.capacityCellId
      )
    } catch {
      evaluation = {
        status: 'freeze',
        evaluatedAt: new Date(dependencies.now()).toISOString(),
        failures: [{
          code: 'collector_failed',
          source: 'cloud-monitoring'
        }]
      }
    }
    state.totalSampleCount++
    state.lastSampleAt = evaluation.evaluatedAt
    const continuityFailures = evaluation.failures.filter((failure) =>
      CONTINUITY_FAILURE_CODES.has(failure.code)
    )
    const thresholdFailures = evaluation.failures.filter((failure) =>
      !CONTINUITY_FAILURE_CODES.has(failure.code)
    )
    if (continuityFailures.length > 0) {
      resetContinuousWindow(state, evaluation.evaluatedAt, continuityFailures)
    } else {
      if (state.windowStartedAt === null) {
        state.windowStartedAt = evaluation.evaluatedAt
      }
      state.sampleCount++
    }
    if (thresholdFailures.length > 0) {
      state.frozenAt ??= evaluation.evaluatedAt
      state.failures = [...state.failures, ...thresholdFailures]
    }
    if (state.windowStartedAt === null) {
      if (dependencies.now() >= lineageDeadlineMs) {
        completeContinuityDeadline(state, dependencies.now(), lineageStartMs)
        await dependencies.persist(state)
        break
      }
      await dependencies.persist(state)
      await dependencies.wait(
        Math.max(0, Math.min(state.intervalMs, lineageDeadlineMs - dependencies.now()))
      )
      continue
    }
    const startMs = Date.parse(state.windowStartedAt)
    const endMs = startMs + state.durationMinutes * 60_000
    const elapsedMinutes = (dependencies.now() - startMs) / 60_000
    while (
      state.nextCheckpointIndex < checkpoints.length &&
      elapsedMinutes >= checkpoints[state.nextCheckpointIndex]!
    ) {
      const minute = checkpoints[state.nextCheckpointIndex]!
      await dependencies.checkpoint({
        schemaVersion: 4,
        incidentId: state.incidentId,
        environment: state.environment,
        expectedSelector: state.expectedSelector,
        preDrainDryRun: state.preDrainDryRun,
        migrationPolicy: state.migrationPolicy,
        recoverySourceCellId: state.recoverySourceCellId,
        capacityCellId: state.capacityCellId,
        windowSequence: state.windowSequence,
        windowStartedAt: state.windowStartedAt,
        checkpointMinute: minute,
        scheduledAt: new Date(startMs + minute * 60_000).toISOString(),
        recordedAt: new Date(dependencies.now()).toISOString(),
        status: state.frozenAt ? 'freeze' : 'green',
        frozenAt: state.frozenAt,
        sampleCount: state.sampleCount,
        failures: state.failures,
        thresholds: INCIDENT_MONITOR_THRESHOLDS
      })
      state.nextCheckpointIndex++
    }
    if (state.preDrainDryRun && state.frozenAt !== null) {
      state.completedAt = new Date(dependencies.now()).toISOString()
      await dependencies.persist(state)
      break
    }
    if (dependencies.now() >= endMs) {
      state.completedAt = new Date(dependencies.now()).toISOString()
      await dependencies.persist(state)
      break
    }
    if (dependencies.now() >= lineageDeadlineMs) {
      completeContinuityDeadline(state, dependencies.now(), lineageStartMs)
      await dependencies.persist(state)
      break
    }
    await dependencies.persist(state)
    await dependencies.wait(
      Math.max(
        0,
        Math.min(sampleStartedAt + state.intervalMs, endMs, lineageDeadlineMs) - dependencies.now()
      )
    )
  }
  return state
}

export function preDrainDryRunPassed(state: Pick<
  IncidentMonitorState,
  | 'completedAt'
  | 'durationMinutes'
  | 'frozenAt'
  | 'intervalMs'
  | 'preDrainDryRun'
  | 'sampleCount'
  | 'startedAt'
>): boolean {
  const minimumSamples =
    Math.ceil((state.durationMinutes * 60_000) / state.intervalMs) + 1
  const lineageElapsedMs = state.completedAt === null
    ? Number.POSITIVE_INFINITY
    : Date.parse(state.completedAt) - Date.parse(state.startedAt)
  return (
    state.preDrainDryRun &&
    state.durationMinutes === 15 &&
    state.completedAt !== null &&
    lineageElapsedMs >= 0 &&
    lineageElapsedMs <= INCIDENT_PRE_DRAIN_MAX_LINEAGE_MS &&
    state.frozenAt === null &&
    state.sampleCount >= minimumSamples
  )
}
