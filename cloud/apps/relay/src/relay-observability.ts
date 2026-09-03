import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import type { RelayRegion } from '@orca-cloud/relay-contract'
import type { ControlRenewalOutcome } from './assignment-store.js'
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

export type RelayProcessCounts = RelayRuntimeCounts & PostgresPoolPressureCounts

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
  controlRenewalLatenciesMs: number[]
  controlRenewalsByOutcome: Record<string, number>
  controlActivityRecoveries: number
  controlActivityRecoveryFailures: number
}

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
  controlRenewalLatenciesMs: [],
  controlRenewalsByOutcome: {},
  controlActivityRecoveries: 0,
  controlActivityRecoveryFailures: 0
})

function percentile(values: number[], percentileRank: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(percentileRank * sorted.length) - 1] ?? 0
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
      regionFallbacksDelta: deltas.regionFallbacks,
      unavailableRegionsDelta: deltas.unavailableRegions,
      controlClosesByCodeDelta: deltas.controlClosesByCode,
      spliceClosesByTriggerDelta: deltas.spliceClosesByTrigger,
      sqlQueriesDelta: deltas.sqlQueries,
      sqlFailuresDelta: deltas.sqlFailures,
      sqlLatencyMsMax: Number(deltas.sqlLatencyMsMax.toFixed(3)),
      controlRenewalsByOutcomeDelta: deltas.controlRenewalsByOutcome,
      controlRenewalsDelta: deltas.controlRenewalLatenciesMs.length,
      controlRenewalSuccessesDelta: deltas.controlRenewalsByOutcome.renewed ?? 0,
      controlRenewalLeaseMissesDelta:
        deltas.controlRenewalsByOutcome.control_activity_not_found ?? 0,
      controlActivityRecoveriesDelta: deltas.controlActivityRecoveries,
      controlActivityRecoveryFailuresDelta: deltas.controlActivityRecoveryFailures,
      controlRenewalLatencyMsP50: Number(
        percentile(deltas.controlRenewalLatenciesMs, 0.5).toFixed(3)
      ),
      controlRenewalLatencyMsP95: Number(
        percentile(deltas.controlRenewalLatenciesMs, 0.95).toFixed(3)
      ),
      controlRenewalLatencyMsMax: Number(
        Math.max(0, ...deltas.controlRenewalLatenciesMs).toFixed(3)
      ),
      httpLatencyMsMax: Number(deltas.httpLatencyMsMax.toFixed(3)),
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      eventLoopDelayMsP99: Number(p99.toFixed(3))
    })
  }
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
