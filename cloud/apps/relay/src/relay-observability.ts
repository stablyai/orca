import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { RELAY_REGION_METRIC_SEGMENTS, type RelayRegion } from '@orca-cloud/relay-contract'
import type { ControlRenewalOutcome } from './assignment-store.js'
import type { CellInventoryHoldCounts } from './cell-inventory-hold-samples.js'
import type { PostgresPoolPressureCounts } from './postgres-pool-pressure.js'
import type { RelayReadinessObservation } from './relay-readiness.js'

export type RelayRuntimeCounts = {
  totalConnections: number
  inFlightConnections?: number
  reservedConnectionUnits?: number
  enforcedConnectionUnits?: number
  preAuthConnections: number
  controls: number
  splices: number
  pendingSplices: number
  queuedBytes: number
}

export function observedRelayRequests(counts: RelayRuntimeCounts): number {
  return counts.preAuthConnections + counts.controls + counts.splices + counts.pendingSplices
}

export type RelayProcessCounts = RelayRuntimeCounts &
  PostgresPoolPressureCounts &
  Partial<CellInventoryHoldCounts>

export type RegionalRehomeRuntimeSafety = {
  observedAt: number
  sqlFailures: number
  reconnects: number
  controlActivityRecoveryFailures: number
}

export type RegionalRehomeSafetySnapshot = RegionalRehomeRuntimeSafety & {
  databasePoolWaiting: number
  databasePoolWaitersMax: number
  databasePoolWaitMsMax: number
}

export type AssignmentAdmissionOutcome =
  | 'sticky'
  | 'sticky-rejected'
  | 'placement'
  | 'placement-rejected'

export type AssignmentAdmissionLane = 'sticky' | 'placement'

export interface RelayRuntimeObserver {
  recordAuth(success: boolean): void
  recordForwardedBytes(bytes: number): void
  recordHttp(durationMs: number): void
  recordReconnect(): void
  recordSql(durationMs: number, success: boolean): void
  recordControlRenewal?(durationMs: number, outcome: ControlRenewalOutcome): void
  recordControlActivityRecovery?(success: boolean): void
  recordAssignmentAdmission?(outcome: AssignmentAdmissionOutcome): void
  recordAssignmentRejectionReason?(lane: AssignmentAdmissionLane, reason: string): void
  recordRegionRequest?(region: RelayRegion | undefined): void
  recordRegionSelection?(input: {
    targetRegion: RelayRegion
    selectedRegion?: RelayRegion
    fallback: boolean
  }): void
  recordControlClose?(code: number): void
  recordSpliceClose?(trigger: string): void
  recordClientAcceptAbandoned?(stage: RelayClientAcceptStage, elapsedMs: number): void
  recordClientAcceptCompleted?(sample: RelayClientAcceptSample): void
  recordControlRtt?(rttMs: number): void
}

// Which serialized accept step the phone had already hung up behind.
export type RelayClientAcceptStage = 'assignment' | 'credential' | 'activity'

// The attach window and the basis writes that follow it are only measurable once
// the host data leg lands, so they join the serialized pre-attach steps on
// completed accepts only.
export type RelayClientAcceptTimedStage = RelayClientAcceptStage | 'attach' | 'basis'

export const RELAY_CLIENT_ACCEPT_TIMED_STAGES = [
  'assignment',
  'credential',
  'activity',
  'attach',
  'basis'
] as const satisfies readonly RelayClientAcceptTimedStage[]

export type RelayClientAcceptSample = {
  totalMs: number
  stageMs: Record<RelayClientAcceptTimedStage, number>
}

type RelayMetricDeltas = {
  forwardedBytes: number
  authSuccesses: number
  authFailures: number
  reconnects: number
  sqlQueries: number
  sqlFailures: number
  sqlLatencyMsMax: number
  httpLatencyMsMax: number
  stickyAssignments: number
  stickyAssignmentRejections: number
  placementAssignments: number
  placementAssignmentRejections: number
  stickyRejectionsByReason: Record<string, number>
  placementRejectionsByReason: Record<string, number>
  requestedRegions: Record<string, number>
  selectedRegions: Record<string, number>
  regionFallbacks: Record<string, number>
  unavailableRegions: Record<string, number>
  controlClosesByCode: Record<string, number>
  spliceClosesByTrigger: Record<string, number>
  clientAcceptsAbandonedByStage: Record<string, number>
  clientAcceptAbandonedMsMax: number
  clientAcceptTotalsMs: number[]
  clientAcceptStageSamplesMs: Record<RelayClientAcceptTimedStage, number[]>
  controlRttSamplesMs: number[]
  controlRttObserved: number
  controlRenewalLatenciesMs: number[]
  controlRenewalsByOutcome: Record<string, number>
  controlActivityRecoveries: number
  controlActivityRecoveryFailures: number
}

// A host chooses how often it answers a ping, so the process-wide window is a
// reservoir: the heap cost of a flood is capped and the percentiles stay unbiased.
export const CONTROL_RTT_RESERVOIR_LIMIT = 1024

type MetricWriter = (entry: Record<string, unknown>) => void

const emptyDeltas = (): RelayMetricDeltas => ({
  forwardedBytes: 0,
  authSuccesses: 0,
  authFailures: 0,
  reconnects: 0,
  sqlQueries: 0,
  sqlFailures: 0,
  sqlLatencyMsMax: 0,
  httpLatencyMsMax: 0,
  stickyAssignments: 0,
  stickyAssignmentRejections: 0,
  placementAssignments: 0,
  placementAssignmentRejections: 0,
  stickyRejectionsByReason: {},
  placementRejectionsByReason: {},
  requestedRegions: {},
  selectedRegions: {},
  regionFallbacks: {},
  unavailableRegions: {},
  controlClosesByCode: {},
  spliceClosesByTrigger: {},
  clientAcceptsAbandonedByStage: {},
  clientAcceptAbandonedMsMax: 0,
  clientAcceptTotalsMs: [],
  clientAcceptStageSamplesMs: {
    assignment: [],
    credential: [],
    activity: [],
    attach: [],
    basis: []
  },
  controlRttSamplesMs: [],
  controlRttObserved: 0,
  controlRenewalLatenciesMs: [],
  controlRenewalsByOutcome: {},
  controlActivityRecoveries: 0,
  controlActivityRecoveryFailures: 0
})

export function percentile(values: number[], percentileRank: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(percentileRank * sorted.length) - 1] ?? 0
}

function roundMs(value: number): number {
  return Number(value.toFixed(3))
}

// Spreading a window into Math.max blows the stack once a busy cell samples
// enough of it, so the maximum is folded instead.
function latencySummary(samples: number[]): { p50: number; p95: number; max: number } {
  return {
    p50: roundMs(percentile(samples, 0.5)),
    p95: roundMs(percentile(samples, 0.95)),
    max: roundMs(samples.reduce((highest, sample) => Math.max(highest, sample), 0))
  }
}

export class RelayObservability implements RelayRuntimeObserver {
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 })
  private deltas = emptyDeltas()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastFlushAt = 0
  private lastFlushedSafety = {
    sqlFailures: 0,
    reconnects: 0,
    controlActivityRecoveryFailures: 0
  }

  constructor(
    private readonly identity: { role: string; cellId: string; region: RelayRegion },
    private readonly write: MetricWriter = (entry) => console.log(JSON.stringify(entry))
  ) {}

  recordAuth(success: boolean): void {
    if (success) this.deltas.authSuccesses++
    else this.deltas.authFailures++
  }

  recordForwardedBytes(bytes: number): void {
    this.deltas.forwardedBytes += bytes
  }

  recordHttp(durationMs: number): void {
    this.deltas.httpLatencyMsMax = Math.max(this.deltas.httpLatencyMsMax, durationMs)
  }

  recordReconnect(): void {
    this.deltas.reconnects++
  }

  recordAssignmentAdmission(outcome: AssignmentAdmissionOutcome): void {
    if (outcome === 'sticky') this.deltas.stickyAssignments++
    else if (outcome === 'sticky-rejected') this.deltas.stickyAssignmentRejections++
    else if (outcome === 'placement') this.deltas.placementAssignments++
    else this.deltas.placementAssignmentRejections++
  }

  recordAssignmentRejectionReason(lane: AssignmentAdmissionLane, reason: string): void {
    const counts =
      lane === 'sticky'
        ? this.deltas.stickyRejectionsByReason
        : this.deltas.placementRejectionsByReason
    counts[reason] = (counts[reason] ?? 0) + 1
  }

  recordRegionRequest(region: RelayRegion | undefined): void {
    increment(this.deltas.requestedRegions, region ?? 'unhinted')
  }

  recordRegionSelection(input: {
    targetRegion: RelayRegion
    selectedRegion?: RelayRegion
    fallback: boolean
  }): void {
    if (input.selectedRegion) increment(this.deltas.selectedRegions, input.selectedRegion)
    else increment(this.deltas.unavailableRegions, input.targetRegion)
    if (input.fallback) increment(this.deltas.regionFallbacks, input.targetRegion)
  }

  recordSql(durationMs: number, success: boolean): void {
    this.deltas.sqlQueries++
    if (!success) this.deltas.sqlFailures++
    this.deltas.sqlLatencyMsMax = Math.max(this.deltas.sqlLatencyMsMax, durationMs)
  }

  recordControlRenewal(durationMs: number, outcome: ControlRenewalOutcome): void {
    this.deltas.controlRenewalLatenciesMs.push(durationMs)
    this.deltas.controlRenewalsByOutcome[outcome] =
      (this.deltas.controlRenewalsByOutcome[outcome] ?? 0) + 1
  }

  recordControlActivityRecovery(success: boolean): void {
    if (success) this.deltas.controlActivityRecoveries++
    else this.deltas.controlActivityRecoveryFailures++
  }

  recordReadiness(observation: RelayReadinessObservation): void {
    this.write({
      severity: observation.ready ? 'INFO' : 'WARNING',
      message: 'Orca Relay readiness check',
      event: 'orca_relay_readiness_check',
      metricVersion: 1,
      ...this.identity,
      ...observation
    })
  }

  recordControlClose(code: number): void {
    const key = String(code)
    this.deltas.controlClosesByCode[key] = (this.deltas.controlClosesByCode[key] ?? 0) + 1
  }

  recordSpliceClose(trigger: string): void {
    this.deltas.spliceClosesByTrigger[trigger] =
      (this.deltas.spliceClosesByTrigger[trigger] ?? 0) + 1
  }

  recordClientAcceptAbandoned(stage: RelayClientAcceptStage, elapsedMs: number): void {
    increment(this.deltas.clientAcceptsAbandonedByStage, stage)
    this.deltas.clientAcceptAbandonedMsMax = Math.max(
      this.deltas.clientAcceptAbandonedMsMax,
      elapsedMs
    )
  }

  recordClientAcceptCompleted(sample: RelayClientAcceptSample): void {
    this.deltas.clientAcceptTotalsMs.push(sample.totalMs)
    for (const stage of RELAY_CLIENT_ACCEPT_TIMED_STAGES) {
      this.deltas.clientAcceptStageSamplesMs[stage].push(sample.stageMs[stage])
    }
  }

  recordControlRtt(rttMs: number): void {
    const samples = this.deltas.controlRttSamplesMs
    const observedBefore = this.deltas.controlRttObserved++
    if (samples.length < CONTROL_RTT_RESERVOIR_LIMIT) {
      samples.push(rttMs)
      return
    }
    // Algorithm R: every round trip in the window keeps an equal chance of being kept.
    const slot = Math.floor(Math.random() * (observedBefore + 1))
    if (slot < CONTROL_RTT_RESERVOIR_LIMIT) samples[slot] = rttMs
  }

  start(readCounts: () => RelayProcessCounts, intervalMs = 30_000): void {
    if (this.timer) return
    this.eventLoop.enable()
    this.timer = setInterval(() => this.flush(readCounts()), intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.eventLoop.disable()
  }

  regionalRehomeRuntimeSafety(): RegionalRehomeRuntimeSafety {
    return {
      observedAt: this.lastFlushAt,
      sqlFailures: this.lastFlushedSafety.sqlFailures + this.deltas.sqlFailures,
      reconnects: this.lastFlushedSafety.reconnects + this.deltas.reconnects,
      controlActivityRecoveryFailures:
        this.lastFlushedSafety.controlActivityRecoveryFailures +
        this.deltas.controlActivityRecoveryFailures
    }
  }

  flush(counts: RelayProcessCounts): void {
    this.lastFlushAt = Date.now()
    const deltas = this.deltas
    this.lastFlushedSafety = {
      sqlFailures: deltas.sqlFailures,
      reconnects: deltas.reconnects,
      controlActivityRecoveryFailures: deltas.controlActivityRecoveryFailures
    }
    this.deltas = emptyDeltas()
    const acceptTotals = latencySummary(deltas.clientAcceptTotalsMs)
    const acceptStageP95 = (stage: RelayClientAcceptTimedStage): number =>
      roundMs(percentile(deltas.clientAcceptStageSamplesMs[stage], 0.95))
    const controlRtt = latencySummary(deltas.controlRttSamplesMs)
    const controlRenewal = latencySummary(deltas.controlRenewalLatenciesMs)
    const memory = process.memoryUsage()
    const p99 = this.eventLoop.count === 0 ? 0 : this.eventLoop.percentile(99) / 1_000_000
    this.eventLoop.reset()
    this.write({
      severity: 'INFO',
      message: 'Orca Relay runtime metrics',
      event: 'orca_relay_runtime_metrics',
      metricVersion: 2,
      role: this.identity.role,
      cellId: this.identity.cellId,
      region: this.identity.region,
      ...counts,
      forwardedBytesDelta: deltas.forwardedBytes,
      authSuccessesDelta: deltas.authSuccesses,
      authFailuresDelta: deltas.authFailures,
      reconnectsDelta: deltas.reconnects,
      stickyAssignmentsDelta: deltas.stickyAssignments,
      stickyAssignmentRejectionsDelta: deltas.stickyAssignmentRejections,
      placementAssignmentsDelta: deltas.placementAssignments,
      placementAssignmentRejectionsDelta: deltas.placementAssignmentRejections,
      stickyRejectionsByReasonDelta: deltas.stickyRejectionsByReason,
      placementRejectionsByReasonDelta: deltas.placementRejectionsByReason,
      requestedRegionsDelta: deltas.requestedRegions,
      selectedRegionsDelta: deltas.selectedRegions,
      ...regionCounterFields('requestedRegion', deltas.requestedRegions),
      ...regionCounterFields('selectedRegion', deltas.selectedRegions),
      regionFallbacksDelta: deltas.regionFallbacks,
      unavailableRegionsDelta: deltas.unavailableRegions,
      controlClosesByCodeDelta: deltas.controlClosesByCode,
      spliceClosesByTriggerDelta: deltas.spliceClosesByTrigger,
      clientAcceptsAbandonedByStageDelta: deltas.clientAcceptsAbandonedByStage,
      clientAcceptAbandonedMsMax: roundMs(deltas.clientAcceptAbandonedMsMax),
      clientAcceptCompletedDelta: deltas.clientAcceptTotalsMs.length,
      // Accepts are sparse: publishing a zero percentile for every empty window
      // would pin the p50 at 0 forever and collapse the p95 at low accept rates.
      ...(deltas.clientAcceptTotalsMs.length === 0
        ? {}
        : {
            clientAcceptTotalMsP50: acceptTotals.p50,
            clientAcceptTotalMsP95: acceptTotals.p95,
            clientAcceptTotalMsMax: acceptTotals.max,
            clientAcceptAssignmentMsP95: acceptStageP95('assignment'),
            clientAcceptCredentialMsP95: acceptStageP95('credential'),
            clientAcceptActivityMsP95: acceptStageP95('activity'),
            clientAcceptAttachMsP95: acceptStageP95('attach'),
            clientAcceptBasisMsP95: acceptStageP95('basis')
          }),
      // Every round trip observed in the window, including the ones the reservoir
      // above declined to keep; the percentiles summarise only what it kept.
      controlRttSamplesDelta: deltas.controlRttObserved,
      controlRttSamplesDroppedDelta: deltas.controlRttObserved - deltas.controlRttSamplesMs.length,
      ...(deltas.controlRttSamplesMs.length === 0
        ? {}
        : {
            controlRttMsP50: controlRtt.p50,
            controlRttMsP95: controlRtt.p95,
            controlRttMsMax: controlRtt.max
          }),
      sqlQueriesDelta: deltas.sqlQueries,
      sqlFailuresDelta: deltas.sqlFailures,
      sqlLatencyMsMax: roundMs(deltas.sqlLatencyMsMax),
      controlRenewalsByOutcomeDelta: deltas.controlRenewalsByOutcome,
      controlRenewalsDelta: deltas.controlRenewalLatenciesMs.length,
      controlRenewalSuccessesDelta: deltas.controlRenewalsByOutcome.renewed ?? 0,
      controlRenewalLeaseMissesDelta:
        deltas.controlRenewalsByOutcome.control_activity_not_found ?? 0,
      controlActivityRecoveriesDelta: deltas.controlActivityRecoveries,
      controlActivityRecoveryFailuresDelta: deltas.controlActivityRecoveryFailures,
      controlRenewalLatencyMsP50: controlRenewal.p50,
      controlRenewalLatencyMsP95: controlRenewal.p95,
      controlRenewalLatencyMsMax: controlRenewal.max,
      httpLatencyMsMax: roundMs(deltas.httpLatencyMsMax),
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      eventLoopDelayMsP99: Number(p99.toFixed(3))
    })
  }
}

// Flat siblings of the nested region maps, always emitted for every region including zeros.
// A log-based metric cannot reach `requestedRegionsDelta."asia-east2"` without a quoted field
// path, and an absent key would drop a series out of the inner join the region-skew alert does.
// The maps stay authoritative and keep carrying anything outside the catalog, such as `unhinted`.
function regionCounterFields(
  prefix: 'requestedRegion' | 'selectedRegion',
  counts: Record<string, number>
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(RELAY_REGION_METRIC_SEGMENTS).map(([region, segment]) => [
      `${prefix}${segment}Delta`,
      counts[region] ?? 0
    ])
  )
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}

export function timedRelayOperation<T>(
  operation: () => Promise<T>,
  observe: (durationMs: number, success: boolean) => void,
  isExpectedError: (error: unknown) => boolean = () => false
): Promise<T> {
  const startedAt = performance.now()
  return operation().then(
    (result) => {
      observe(performance.now() - startedAt, true)
      return result
    },
    (error: unknown) => {
      observe(performance.now() - startedAt, isExpectedError(error))
      throw error
    }
  )
}
