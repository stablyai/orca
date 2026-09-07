import { RELAY_REGION_METRIC_SEGMENTS, RELAY_REGIONS } from '@orca-cloud/relay-contract'
import { describe, expect, it, vi } from 'vitest'
import type { RelayDatabase } from './database.js'
import { observeRelayDatabase } from './observed-relay-database.js'
import {
  CONTROL_RTT_RESERVOIR_LIMIT,
  observedRelayRequests,
  RelayObservability,
  type RelayProcessCounts
} from './relay-observability.js'

const counts: RelayProcessCounts = {
  totalConnections: 9,
  preAuthConnections: 1,
  controls: 2,
  splices: 3,
  pendingSplices: 1,
  queuedBytes: 4096,
  databasePoolTotal: 3,
  databasePoolIdle: 0,
  databasePoolWaiting: 2,
  databasePoolWaitersMax: 3,
  databasePoolOldestWaitMs: 750,
  databasePoolWaitMsMax: 1_250
}

// Two schema keys legitimately spell a policed word: the abandoned-accept bucket
// is keyed by stage name and one stage is `credential`. Rename those exact keys in
// a clone instead of rewriting the JSON, so a stray raw field or value anywhere
// else still trips the guard below.
const SCHEMA_KEY_ALIASES: Record<string, string> = {
  clientAcceptCredentialMsP95: 'clientAcceptStageTwoMsP95'
}

function scrubSchemaKeys(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify(
    entries.map((entry) =>
      Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          SCHEMA_KEY_ALIASES[key] ?? key,
          key === 'clientAcceptsAbandonedByStageDelta' ? renameStageKeys(value) : value
        ])
      )
    )
  )
}

function renameStageKeys(bucket: unknown): unknown {
  if (bucket === null || typeof bucket !== 'object') return bucket
  return Object.fromEntries(
    Object.entries(bucket).map(([stage, count]) => [
      stage === 'credential' ? 'stageTwo' : stage,
      count
    ])
  )
}

describe('relay observability', () => {
  it('emits safe readiness dependency outcomes', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'production-gce-c28', region: 'asia-east2' },
      (entry) => entries.push(entry)
    )

    observability.recordReadiness({
      ready: false,
      failure: 'sql_failed',
      jwksLatencyMs: 12,
      sqlLatencyMs: 2_001,
      totalLatencyMs: 2_013
    })

    expect(entries).toEqual([
      {
        severity: 'WARNING',
        message: 'Orca Relay readiness check',
        event: 'orca_relay_readiness_check',
        metricVersion: 1,
        role: 'cell',
        cellId: 'production-gce-c28',
        region: 'asia-east2',
        ready: false,
        failure: 'sql_failed',
        jwksLatencyMs: 12,
        sqlLatencyMs: 2_001,
        totalLatencyMs: 2_013
      }
    ])
  })

  it('excludes sockets stuck in closing state from observed relay work', () => {
    expect(observedRelayRequests(counts)).toBe(7)
  })

  it('keeps rejection reasons separate per lane and resets them each flush', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'director', cellId: 'director', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    observability.recordAssignmentAdmission('placement-rejected')
    observability.recordAssignmentRejectionReason('placement', 'host-rate-limited')
    observability.recordAssignmentRejectionReason('placement', 'host-rate-limited')
    observability.recordAssignmentRejectionReason('placement', 'queue-full')
    observability.recordAssignmentRejectionReason('sticky', 'wait-timeout')
    observability.flush(counts)
    observability.flush(counts)

    expect(entries[0]).toMatchObject({
      placementAssignmentRejectionsDelta: 1,
      placementRejectionsByReasonDelta: { 'host-rate-limited': 2, 'queue-full': 1 },
      stickyRejectionsByReasonDelta: { 'wait-timeout': 1 }
    })
    expect(entries[1]).toMatchObject({
      placementRejectionsByReasonDelta: {},
      stickyRejectionsByReasonDelta: {}
    })
  })

  it('aggregates coarse region requests, selections, fallbacks, and outages', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'director', cellId: 'director', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    observability.recordRegionRequest('asia-east2')
    observability.recordRegionRequest(undefined)
    observability.recordRegionSelection({
      targetRegion: 'asia-east2',
      selectedRegion: 'us-central1',
      fallback: true
    })
    observability.recordRegionSelection({ targetRegion: 'asia-east2', fallback: false })
    observability.flush(counts)
    observability.flush(counts)

    expect(entries[0]).toMatchObject({
      requestedRegionsDelta: { 'asia-east2': 1, unhinted: 1 },
      selectedRegionsDelta: { 'us-central1': 1 },
      regionFallbacksDelta: { 'asia-east2': 1 },
      unavailableRegionsDelta: { 'asia-east2': 1 },
      // Flat per-region siblings the log-based metrics extract; `unhinted` stays map-only.
      requestedRegionUsCentral1Delta: 0,
      requestedRegionAsiaEast2Delta: 1,
      selectedRegionUsCentral1Delta: 1,
      selectedRegionAsiaEast2Delta: 0
    })
    expect(entries[1]).toMatchObject({
      requestedRegionsDelta: {},
      selectedRegionsDelta: {},
      regionFallbacksDelta: {},
      unavailableRegionsDelta: {},
      // Zeros keep publishing so an idle window cannot drop a series out of the skew join.
      requestedRegionUsCentral1Delta: 0,
      requestedRegionAsiaEast2Delta: 0,
      selectedRegionUsCentral1Delta: 0,
      selectedRegionAsiaEast2Delta: 0
    })
    // A region added to the contract has to reach the flat keys, or the skew alert's
    // denominator silently misses it.
    for (const segment of Object.values(RELAY_REGION_METRIC_SEGMENTS)) {
      expect(entries[0]).toHaveProperty(`requestedRegion${segment}Delta`)
      expect(entries[0]).toHaveProperty(`selectedRegion${segment}Delta`)
    }
    expect(Object.keys(RELAY_REGION_METRIC_SEGMENTS).sort()).toEqual([...RELAY_REGIONS].sort())
  })

  it('emits bounded aggregate runtime signals without identities or credentials', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'staging-c1', region: 'asia-east2' },
      (entry) => entries.push(entry)
    )
    observability.recordAuth(true)
    observability.recordAuth(false)
    observability.recordForwardedBytes(123)
    observability.recordHttp(45.6789)
    observability.recordReconnect()
    observability.recordSql(12.3456, true)
    observability.recordSql(4, false)
    observability.recordControlRenewal(2, 'renewed')
    observability.recordControlRenewal(8, 'control_activity_not_found')
    observability.recordControlRenewal(4, 'renewed')
    observability.recordControlActivityRecovery(true)
    observability.recordControlActivityRecovery(false)
    observability.flush(counts)
    observability.flush(counts)

    expect(entries[0]).toMatchObject({
      event: 'orca_relay_runtime_metrics',
      metricVersion: 2,
      role: 'cell',
      cellId: 'staging-c1',
      region: 'asia-east2',
      ...counts,
      forwardedBytesDelta: 123,
      authSuccessesDelta: 1,
      authFailuresDelta: 1,
      reconnectsDelta: 1,
      sqlQueriesDelta: 2,
      sqlFailuresDelta: 1,
      sqlLatencyMsMax: 12.346,
      controlRenewalsByOutcomeDelta: { renewed: 2, control_activity_not_found: 1 },
      controlRenewalsDelta: 3,
      controlRenewalSuccessesDelta: 2,
      controlRenewalLeaseMissesDelta: 1,
      controlRenewalLatencyMsP50: 4,
      controlRenewalLatencyMsP95: 8,
      controlRenewalLatencyMsMax: 8,
      controlActivityRecoveriesDelta: 1,
      controlActivityRecoveryFailuresDelta: 1,
      httpLatencyMsMax: 45.679
    })
    expect(entries[1]).toMatchObject({
      forwardedBytesDelta: 0,
      authSuccessesDelta: 0,
      authFailuresDelta: 0,
      reconnectsDelta: 0,
      sqlQueriesDelta: 0,
      sqlFailuresDelta: 0,
      sqlLatencyMsMax: 0,
      controlRenewalsByOutcomeDelta: {},
      controlRenewalsDelta: 0,
      controlRenewalSuccessesDelta: 0,
      controlRenewalLeaseMissesDelta: 0,
      controlRenewalLatencyMsP50: 0,
      controlRenewalLatencyMsP95: 0,
      controlRenewalLatencyMsMax: 0,
      controlActivityRecoveriesDelta: 0,
      controlActivityRecoveryFailuresDelta: 0,
      httpLatencyMsMax: 0
    })
    expect(scrubSchemaKeys(entries)).not.toMatch(/token|credential|userId|relayHostId/i)
  })

  it('aggregates control and splice closes as bounded per-reason deltas', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'staging-c1', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    observability.recordControlClose(1006)
    observability.recordControlClose(1006)
    observability.recordControlClose(4402)
    observability.recordSpliceClose('host-oversize-frame')
    observability.recordSpliceClose('queue-limit')
    observability.recordClientAcceptAbandoned('activity', 14_250.4)
    observability.recordClientAcceptAbandoned('activity', 2_000)
    observability.recordClientAcceptAbandoned('credential', 3_000)
    observability.flush(counts)
    observability.flush(counts)

    expect(entries[0]).toMatchObject({
      controlClosesByCodeDelta: { 1006: 2, 4402: 1 },
      spliceClosesByTriggerDelta: { 'host-oversize-frame': 1, 'queue-limit': 1 },
      clientAcceptsAbandonedByStageDelta: { activity: 2, credential: 1 },
      clientAcceptAbandonedMsMax: 14_250.4
    })
    expect(entries[1]).toMatchObject({
      controlClosesByCodeDelta: {},
      spliceClosesByTriggerDelta: {},
      clientAcceptsAbandonedByStageDelta: {},
      clientAcceptAbandonedMsMax: 0
    })
  })

  it('summarises completed client accepts and control round trips per window', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'production-gce-c28', region: 'asia-east2' },
      (entry) => entries.push(entry)
    )
    observability.recordClientAcceptCompleted({
      totalMs: 812.4567,
      stageMs: { assignment: 120, credential: 90, activity: 40, attach: 500, basis: 62 }
    })
    observability.recordClientAcceptCompleted({
      totalMs: 6_400,
      stageMs: { assignment: 4_100, credential: 95, activity: 60, attach: 2_000, basis: 145 }
    })
    observability.recordControlRtt(28)
    observability.recordControlRtt(240)
    observability.recordControlRtt(31)
    observability.flush(counts)
    observability.flush(counts)

    expect(entries[0]).toMatchObject({
      clientAcceptCompletedDelta: 2,
      clientAcceptTotalMsP50: 812.457,
      clientAcceptTotalMsP95: 6_400,
      clientAcceptTotalMsMax: 6_400,
      clientAcceptAssignmentMsP95: 4_100,
      clientAcceptCredentialMsP95: 95,
      clientAcceptActivityMsP95: 60,
      clientAcceptAttachMsP95: 2_000,
      clientAcceptBasisMsP95: 145,
      controlRttSamplesDelta: 3,
      controlRttMsP50: 31,
      controlRttMsP95: 240,
      controlRttMsMax: 240
    })
    // Only-add: the pre-existing fields still read the same after the extension.
    expect(entries[0]).toMatchObject({
      event: 'orca_relay_runtime_metrics',
      metricVersion: 2,
      clientAcceptsAbandonedByStageDelta: {},
      clientAcceptAbandonedMsMax: 0
    })
    // An empty window publishes counts only: a zero percentile point is
    // indistinguishable from a real zero once Cloud Logging aggregates it.
    expect(entries[1]).toMatchObject({ clientAcceptCompletedDelta: 0, controlRttSamplesDelta: 0 })
    for (const omitted of [
      'clientAcceptTotalMsP50',
      'clientAcceptTotalMsP95',
      'clientAcceptTotalMsMax',
      'clientAcceptAssignmentMsP95',
      'clientAcceptCredentialMsP95',
      'clientAcceptActivityMsP95',
      'clientAcceptAttachMsP95',
      'clientAcceptBasisMsP95',
      'controlRttMsP50',
      'controlRttMsP95',
      'controlRttMsMax'
    ]) {
      expect(entries[1]).not.toHaveProperty(omitted)
      expect(entries[0]).toHaveProperty(omitted)
    }
    expect(scrubSchemaKeys(entries)).not.toMatch(/token|credential|userId|relayHostId/i)
  })

  it('caps the control round-trip reservoir and reports what it dropped', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'production-gce-c28', region: 'asia-east2' },
      (entry) => entries.push(entry)
    )
    const flooded = CONTROL_RTT_RESERVOIR_LIMIT * 20
    for (let sample = 0; sample < flooded; sample++) {
      observability.recordControlRtt(10 + (sample % 40))
    }
    observability.flush(counts)

    // Dropped is observed minus retained, so this pins the retained window at the cap.
    expect(entries[0]).toMatchObject({
      controlRttSamplesDelta: flooded,
      controlRttSamplesDroppedDelta: flooded - CONTROL_RTT_RESERVOIR_LIMIT
    })
    // The kept samples are real observations, not a truncated or synthesised window.
    expect(entries[0]!.controlRttMsP50 as number).toBeGreaterThanOrEqual(10)
    expect(entries[0]!.controlRttMsMax as number).toBeLessThanOrEqual(49)

    observability.flush(counts)
    expect(entries[1]).toMatchObject({
      controlRttSamplesDelta: 0,
      controlRttSamplesDroppedDelta: 0
    })
    expect(entries[1]).not.toHaveProperty('controlRttMsP50')
  })

  it('samples the whole flooded window rather than its first samples', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'production-gce-c28', region: 'asia-east2' },
      (entry) => entries.push(entry)
    )
    const half = CONTROL_RTT_RESERVOIR_LIMIT * 10
    for (let sample = 0; sample < half; sample++) observability.recordControlRtt(10)
    for (let sample = 0; sample < half; sample++) observability.recordControlRtt(900)
    observability.flush(counts)

    // Keeping the first N instead would publish a window of nothing but 10s. Each
    // reservoir slot ends up drawn from the late half with ~1/2 probability, so
    // fewer than the 5% the p95 needs is out of reach of this suite.
    expect(entries[0]!.controlRttMsP95).toBe(900)
    expect(entries[0]!.controlRttMsMax).toBe(900)
  })

  it('observes successful and failed database calls including transactions', async () => {
    const recordSql = vi.fn()
    const underlying: RelayDatabase = {
      query: vi.fn(async () => [{ ok: true }]),
      queryLocked: vi.fn(async (sql, _params, options) => {
        throw new Error(
          options?.failIfUnavailable && sql === 'SELECT 3'
            ? 'database_lock_unavailable'
            : 'database unavailable'
        )
      }),
      transaction: async (operation) => await operation(underlying),
      close: vi.fn(async () => {})
    }
    const database = observeRelayDatabase(underlying, {
      recordAuth: vi.fn(),
      recordForwardedBytes: vi.fn(),
      recordHttp: vi.fn(),
      recordReconnect: vi.fn(),
      recordSql
    })

    await database.query('SELECT 1')
    await expect(database.transaction(async (tx) => await tx.queryLocked('SELECT 2'))).rejects.toThrow(
      'database unavailable'
    )
    await expect(
      database.queryLocked('SELECT 3', [], { failIfUnavailable: true })
    ).rejects.toThrow('database_lock_unavailable')
    await expect(
      database.queryLocked('SELECT 4', [], { failIfUnavailable: true })
    ).rejects.toThrow('database unavailable')
    expect(recordSql).toHaveBeenCalledTimes(4)
    expect(recordSql.mock.calls.map((call) => call[1])).toEqual([true, false, true, false])
  })
})
