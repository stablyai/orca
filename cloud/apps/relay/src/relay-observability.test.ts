import { describe, expect, it, vi } from 'vitest'
import type { RelayDatabase } from './database.js'
import { observeRelayDatabase } from './observed-relay-database.js'
import {
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
      unavailableRegionsDelta: { 'asia-east2': 1 }
    })
    expect(entries[1]).toMatchObject({
      requestedRegionsDelta: {},
      selectedRegionsDelta: {},
      regionFallbacksDelta: {},
      unavailableRegionsDelta: {}
    })
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
    expect(JSON.stringify(entries)).not.toMatch(/token|credential|userId|relayHostId/)
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
    observability.flush(counts)
    observability.flush(counts)

    expect(entries[0]).toMatchObject({
      controlClosesByCodeDelta: { 1006: 2, 4402: 1 },
      spliceClosesByTriggerDelta: { 'host-oversize-frame': 1, 'queue-limit': 1 }
    })
    expect(entries[1]).toMatchObject({
      controlClosesByCodeDelta: {},
      spliceClosesByTriggerDelta: {}
    })
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
