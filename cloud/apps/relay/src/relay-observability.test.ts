import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayDatabase } from './database.js'
import { observeRelayDatabase } from './observed-relay-database.js'
import {
  CONTROL_RTT_RESERVOIR_LIMIT,
  observedRelayRequests,
  percentile,
  PRE_AUTH_RESERVOIR_LIMIT,
  RelayObservability,
  STICKY_CONNECTION_LIMIT,
  type RelayProcessCounts
} from './relay-observability.js'
import { RELAY_FIX_LEVEL } from './relay-fix-level.js'

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

// Alias only legitimate credential schema keys in a clone so raw secret fields/values elsewhere still trip the guard.
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
  afterEach(() => vi.restoreAllMocks())
  it('stamps every runtime metrics line with the fix level', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'production-gce-c25', region: 'asia-east2' },
      (entry) => entries.push(entry)
    )
    observability.flush(counts)
    expect(entries[0]).toMatchObject({
      event: 'orca_relay_runtime_metrics',
      fixLevel: RELAY_FIX_LEVEL
    })
  })

  // Why: a director whose loop froze for 134 s still reported a 68 ms p99 (staging 2026-10-11).
  it('reports one long event-loop freeze as the window max', async () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'director', cellId: 'director', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    observability.start(() => counts, 3_600_000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const frozenUntil = performance.now() + 300
    while (performance.now() < frozenUntil) {
      // Holds the loop the way a blocking connect() does.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    observability.flush(counts)
    observability.stop()
    expect(entries[0]!.eventLoopDelayMsMax).toBeGreaterThanOrEqual(250)
  })

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

  it('flags a readiness answer served from the last known good probe', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'production-gce-c28', region: 'asia-east2' },
      (entry) => entries.push(entry)
    )

    observability.recordReadiness({
      ready: true,
      degraded: true,
      degradedDependencies: ['jwks'],
      failure: 'jwks_timed_out',
      jwksLatencyMs: 2_001,
      sqlLatencyMs: 4,
      totalLatencyMs: 2_002
    })

    expect(entries).toEqual([
      expect.objectContaining({
        severity: 'WARNING',
        event: 'orca_relay_readiness_check',
        ready: true,
        degraded: true,
        degradedDependencies: ['jwks'],
        failure: 'jwks_timed_out'
      })
    ])
  })

  it('separates entering the readiness grace window from leaving it', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'production-gce-c28', region: 'asia-east2' },
      (entry) => entries.push(entry)
    )

    observability.recordReadinessGrace({
      dependency: 'sql',
      grace: 'entered',
      failure: 'sql_failed',
      lastSuccessAgeMs: 12_000,
      graceMs: 180_000
    })
    observability.recordReadinessGrace({
      dependency: 'sql',
      grace: 'recovered',
      lastSuccessAgeMs: 0,
      graceMs: 180_000
    })

    expect(entries).toEqual([
      {
        severity: 'WARNING',
        message: 'Orca Relay readiness entered last-known-good grace',
        event: 'orca_relay_readiness_grace_entered',
        metricVersion: 1,
        role: 'cell',
        cellId: 'production-gce-c28',
        region: 'asia-east2',
        dependency: 'sql',
        grace: 'entered',
        failure: 'sql_failed',
        lastSuccessAgeMs: 12_000,
        graceMs: 180_000
      },
      {
        severity: 'INFO',
        message: 'Orca Relay readiness left last-known-good grace',
        event: 'orca_relay_readiness_grace_left',
        metricVersion: 1,
        role: 'cell',
        cellId: 'production-gce-c28',
        region: 'asia-east2',
        dependency: 'sql',
        grace: 'recovered',
        lastSuccessAgeMs: 0,
        graceMs: 180_000
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

  it('splits non-drain 503s from scheduled drain-return deferrals', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'director', cellId: 'director', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    for (let index = 0; index < 40; index++) {
      observability.recordAssignmentUnavailable('drain-return-deferred')
    }
    observability.recordAssignmentUnavailable('reserve-paced-drained')
    observability.recordAssignmentUnavailable('sticky-lane')
    observability.recordAssignmentUnavailable('relay_capacity_exhausted')
    observability.recordAssignmentUnavailable('relay_capacity_exhausted')
    observability.flush(counts)
    observability.flush(counts)

    expect(entries[0]).toMatchObject({
      assign503sByCauseDelta: {
        'drain-return-deferred': 40,
        'reserve-paced-drained': 1,
        'sticky-lane': 1,
        relay_capacity_exhausted: 2
      },
      assignNonDrain503sDelta: 3
    })
    expect(entries[1]).toMatchObject({ assign503sByCauseDelta: {}, assignNonDrain503sDelta: 0 })
  })

  it('reports lane slot service times only for windows that served the lane', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'director', cellId: 'director', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    for (let ms = 1; ms <= 100; ms++) {
      observability.recordAdmissionServiceMs('sticky', ms)
      observability.recordAdmissionServiceMs('drain-return', ms * 10)
    }
    observability.flush(counts)
    observability.flush(counts)

    expect(entries[0]).toMatchObject({
      stickyServiceMsP50: 50,
      stickyServiceMsP99: 99,
      drainReturnServiceMsP50: 500,
      drainReturnServiceMsP95: 950
    })
    expect(entries[1]).not.toHaveProperty('stickyServiceMsP50')
    expect(entries[1]).not.toHaveProperty('drainReturnServiceMsP50')
  })

  it('summarises sticky slots per window and per pooled connection', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'director', cellId: 'director', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    for (let ms = 1; ms <= 100; ms++) {
      observability.recordStickySlot({
        queueWaitMs: ms * 20,
        poolWaitMs: ms,
        sqlMs: ms * 2,
        statements: 14,
        // The slow connection serves every other request.
        statementMsByConnection: new Map([ms % 2 === 0 ? [1, [300]] : [2, [5, 6]]])
      })
    }
    observability.flush(counts)
    observability.flush(counts)

    expect(entries[0]).toMatchObject({
      stickySlotsDelta: 100,
      stickyQueueWaitMsP50: 1_000,
      stickyQueueWaitMsP99: 1_980,
      stickyQueueWaitMsMax: 2_000,
      stickyPoolWaitMsP50: 50,
      stickyPoolWaitMsP99: 99,
      stickySqlMsP50: 100,
      stickySqlMsP99: 198,
      stickyStatementsP50: 14,
      stickyStatementsMax: 14,
      // 50 statements at 300 ms and 100 at 5-6 ms: the pooled median is the fast connection's.
      stickyStatementMsP50: 6,
      stickySqlByConnection: {
        '1': {
          requests: 50,
          statements: 50,
          statementMsP50: 300,
          statementMsP99: 300,
          statementMsMax: 300
        },
        '2': { requests: 50, statements: 100, statementMsP50: 5, statementMsP99: 6 }
      },
      stickySqlConnectionSamplesDroppedDelta: 0
    })
    expect(entries[1]).not.toHaveProperty('stickySlotsDelta')
    expect(entries[1]).not.toHaveProperty('stickySqlByConnection')
  })

  it('stamps the instance zone once it is known', () => {
    const entries: Record<string, unknown>[] = []
    const observability = new RelayObservability(
      { role: 'director', cellId: 'director', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    observability.flush(counts)
    observability.setInstanceZone('us-central1-a')
    observability.flush(counts)

    expect(entries[0]).not.toHaveProperty('instanceZone')
    expect(entries[1]).toMatchObject({ instanceZone: 'us-central1-a' })
  })

  it('adds the sandbox TCP counter deltas of each window once a reader is set', () => {
    const entries: Record<string, unknown>[] = []
    const observability = new RelayObservability(
      { role: 'director', cellId: 'director', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    const reads = [10, 13, 13, undefined, 20, 2].map((retransSegs) =>
      retransSegs === undefined
        ? undefined
        : { inSegs: retransSegs * 100, outSegs: 0, retransSegs, inErrs: 0, outRsts: 0, estabResets: 0 }
    )
    observability.flush(counts)
    observability.setTcpCounterReader(() => reads.shift())
    for (let window = 0; window < 5; window++) {
      observability.flush(counts)
    }

    expect(entries[0]).not.toHaveProperty('tcpRetransSegsDelta')
    expect(entries[1]).toMatchObject({ tcpRetransSegsDelta: 3, tcpInSegsDelta: 300 })
    expect(entries[2]).toMatchObject({ tcpRetransSegsDelta: 0 })
    // An unreadable window, the window after it, and a counter reset carry no delta.
    expect(entries[3]).not.toHaveProperty('tcpRetransSegsDelta')
    expect(entries[4]).not.toHaveProperty('tcpRetransSegsDelta')
    expect(entries[5]).not.toHaveProperty('tcpRetransSegsDelta')
  })

  it('bounds the per-connection sticky summary', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'director', cellId: 'director', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    for (let id = 1; id <= STICKY_CONNECTION_LIMIT + 3; id++) {
      observability.recordStickySlot({
        queueWaitMs: 0,
        poolWaitMs: 0,
        sqlMs: 1,
        statements: 1,
        statementMsByConnection: new Map([[id, [1]]])
      })
    }
    observability.flush(counts)

    expect(Object.keys(entries[0]?.stickySqlByConnection as object)).toHaveLength(
      STICKY_CONNECTION_LIMIT
    )
    expect(entries[0]).toMatchObject({ stickySqlConnectionSamplesDroppedDelta: 3 })
  })

  it('sums lock waiters per role and table over the samples taken', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'director', cellId: 'director', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    observability.recordDatabaseLockWaitSample([
      { waiterRole: 'cell', table: 'relay_cells', holderRole: 'cell', waiters: 3 },
      { waiterRole: 'director', table: 'relay_cells', holderRole: 'cell', waiters: 1 },
      { waiterRole: 'cell', table: 'relay_assignments', holderRole: 'director', waiters: 2 }
    ])
    observability.recordDatabaseLockWaitSample([])
    observability.recordDatabaseLockWaitSample([
      { waiterRole: 'cell', table: 'relay_cells', holderRole: 'cell', waiters: 1 }
    ])
    observability.flush(counts)

    expect(entries[0]).toMatchObject({
      dbLockWaitSamplesDelta: 3,
      dbLockWaitersByKeyDelta: {
        'cell:relay_cells:cell': 4,
        'director:relay_cells:cell': 1,
        'cell:relay_assignments:director': 2
      },
      dbCellRowLockWaitersDirectorDelta: 1,
      dbCellRowLockWaitersCellDelta: 4
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
    observability.recordPostProofClose('relay draining')
    observability.recordPostProofClose('relay draining')
    observability.recordSpliceClose('host-oversize-frame')
    observability.recordSpliceClose('queue-limit')
    observability.recordClientAcceptAbandoned('activity', 14_250.4)
    observability.recordClientAcceptAbandoned('activity', 2_000)
    observability.recordClientAcceptAbandoned('credential', 3_000)
    observability.flush(counts)
    observability.flush(counts)

    expect(entries[0]).toMatchObject({
      controlClosesByCodeDelta: { 1006: 2, 4402: 1 },
      postProofClosesByReasonDelta: { 'relay draining': 2 },
      spliceClosesByTriggerDelta: { 'host-oversize-frame': 1, 'queue-limit': 1 },
      clientAcceptsAbandonedByStageDelta: { activity: 2, credential: 1 },
      clientAcceptAbandonedMsMax: 14_250.4
    })
    expect(entries[1]).toMatchObject({
      controlClosesByCodeDelta: {},
      postProofClosesByReasonDelta: {},
      spliceClosesByTriggerDelta: {},
      clientAcceptsAbandonedByStageDelta: {},
      clientAcceptAbandonedMsMax: 0
    })
  })

  it('counts the phone path, phone refusals by code and the step-6 failures per window', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'production-gce-c28', region: 'asia-east2' },
      (entry) => entries.push(entry)
    )
    const stageMs = { assignment: 0, credential: 170, activity: 0, attach: 300, basis: 0 }
    observability.recordClientAcceptCompleted({ totalMs: 470, stageMs, phonePath: 'memory' })
    observability.recordClientAcceptCompleted({ totalMs: 3_600, stageMs, phonePath: 'db' })
    observability.recordPhoneRejection(4401)
    observability.recordPhoneRejection(4404)
    observability.recordPhoneRejection(4404)
    observability.recordPhoneAttachDeadline()
    observability.recordPhoneAcceptDatabaseError()
    observability.recordResumeConfirmFailure('reject-revoked')
    observability.recordResumeRenewalFailure()
    observability.flush({ ...counts, resumeAuditDropped: 3 })
    observability.flush(counts)
    expect(entries[0]).toMatchObject({
      clientAcceptsByPhonePathDelta: { memory: 1, db: 1 },
      phoneRejectionsByCodeDelta: { '4401': 1, '4404': 2 },
      phoneAttachDeadlinesDelta: 1,
      phoneAcceptDatabaseErrorsDelta: 1,
      resumeConfirmFailuresByCodeDelta: { 'reject-revoked': 1 },
      resumeRenewalFailuresDelta: 1,
      resumeAuditDropped: 3
    })
    expect(entries[1]).toMatchObject({
      phoneRejectionsByCodeDelta: {},
      phoneAttachDeadlinesDelta: 0,
      phoneAcceptDatabaseErrorsDelta: 0,
      resumeConfirmFailuresByCodeDelta: {}
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
    expect(entries[0]).toMatchObject({
      event: 'orca_relay_runtime_metrics',
      metricVersion: 2,
      clientAcceptsAbandonedByStageDelta: {},
      clientAcceptAbandonedMsMax: 0
    })
    expect(entries[0]).toMatchObject({ clientAcceptsByPhonePathDelta: {} })
    // Omit empty percentiles: aggregated zeros are indistinguishable from actual zero-latency samples.
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

    expect(entries[0]).toMatchObject({
      controlRttSamplesDelta: flooded,
      controlRttSamplesDroppedDelta: flooded - CONTROL_RTT_RESERVOIR_LIMIT
    })
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
    let seed = 42
    vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return seed / 0x1_0000_0000
    })
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'production-gce-c28', region: 'asia-east2' },
      (entry) => entries.push(entry)
    )
    const half = CONTROL_RTT_RESERVOIR_LIMIT * 10
    for (let sample = 0; sample < half; sample++) observability.recordControlRtt(10)
    for (let sample = 0; sample < half; sample++) observability.recordControlRtt(900)
    observability.flush(counts)

    // A first-N reservoir would publish only the early 10 ms samples.
    expect(entries[0]!.controlRttMsP95).toBe(900)
    expect(entries[0]!.controlRttMsMax).toBe(900)
  })

  it('summarises host pre-auth latency per path and outcome', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'staging-gce-c1', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    for (let ms = 1; ms <= 100; ms++) observability.recordHostPreAuth('db', 'admitted', ms)
    observability.recordHostPreAuth('db', 'abandoned', 6_000)
    observability.recordHostPreAuth('beforeCheck', 'refused', 2_000)
    observability.recordHostPreAuth('reserve', 'admitted', 12.3456)
    observability.flush(counts)
    observability.flush(counts)

    const none = { admitted: { count: 0 }, refused: { count: 0 }, abandoned: { count: 0 } }
    const buckets = (filled: Partial<Record<string, number>>): Record<string, number> => ({
      '50': 0,
      '100': 0,
      '200': 0,
      '300': 0,
      '450': 0,
      '700': 0,
      '1000': 0,
      '2000': 0,
      '5000': 0,
      '+Inf': 0,
      ...filled
    })
    expect(entries[0]!.preAuthLatencyMs).toEqual({
      beforeCheck: {
        ...none,
        refused: {
          count: 1,
          p50: 2_000,
          p95: 2_000,
          p99: 2_000,
          max: 2_000,
          bucketsLeMs: buckets({ '2000': 1 })
        }
      },
      db: {
        ...none,
        admitted: {
          count: 100,
          p50: 50,
          p95: 95,
          p99: 99,
          max: 100,
          bucketsLeMs: buckets({ '50': 50, '100': 50 })
        },
        abandoned: {
          count: 1,
          p50: 6_000,
          p95: 6_000,
          p99: 6_000,
          max: 6_000,
          bucketsLeMs: buckets({ '+Inf': 1 })
        }
      },
      reserve: {
        ...none,
        admitted: {
          count: 1,
          p50: 12.346,
          p95: 12.346,
          p99: 12.346,
          max: 12.346,
          bucketsLeMs: buckets({ '50': 1 })
        }
      }
    })
    expect(entries[1]!.preAuthLatencyMs).toEqual({ beforeCheck: none, db: none, reserve: none })
  })

  it('counts every hello in the pre-auth buckets, inclusive of each bound', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'staging-gce-c1', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    const flooded = PRE_AUTH_RESERVOIR_LIMIT * 5
    for (let sample = 0; sample < flooded; sample++) {
      observability.recordHostPreAuth('reserve', 'admitted', 450)
    }
    observability.recordHostPreAuth('reserve', 'admitted', 450.001)
    observability.recordHostPreAuth('reserve', 'admitted', 9_000)
    observability.flush(counts)

    expect(entries[0]).toMatchObject({
      preAuthLatencyMs: {
        reserve: {
          admitted: {
            // Exact past the reservoir cap, even when it declined the slowest hello.
            count: flooded + 2,
            max: 9_000,
            p50: 450,
            bucketsLeMs: { '300': 0, '450': flooded, '700': 1, '5000': 0, '+Inf': 1 }
          }
        }
      }
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
    await expect(
      database.transaction(async (tx) => await tx.queryLocked('SELECT 2'))
    ).rejects.toThrow('database unavailable')
    await expect(database.queryLocked('SELECT 3', [], { failIfUnavailable: true })).rejects.toThrow(
      'database_lock_unavailable'
    )
    await expect(database.queryLocked('SELECT 4', [], { failIfUnavailable: true })).rejects.toThrow(
      'database unavailable'
    )
    expect(recordSql).toHaveBeenCalledTimes(4)
    expect(recordSql.mock.calls.map((call) => call[1])).toEqual([true, false, true, false])
  })
})

function summaryThroughFlush(samples: number[]) {
  const entries: Array<Record<string, unknown>> = []
  const observability = new RelayObservability(
    { role: 'cell', cellId: 'staging-c1', region: 'us-central1' },
    (entry) => entries.push(entry)
  )
  for (const sample of samples) observability.recordControlRenewal(sample, 'renewed')
  observability.flush(counts)
  const entry = entries[0]!
  return {
    p50: entry.controlRenewalLatencyMsP50,
    p95: entry.controlRenewalLatencyMsP95,
    max: entry.controlRenewalLatencyMsMax
  }
}

describe('latency window summarisation', () => {
  it.each([
    { name: 'empty', values: [], expected: { p50: 0, p95: 0, max: 0 } },
    { name: 'single', values: [7.5], expected: { p50: 7.5, p95: 7.5, max: 7.5 } },
    { name: 'unsorted', values: [10, 1, 5, 3], expected: { p50: 3, p95: 10, max: 10 } },
    { name: 'duplicates', values: [4, 4, 4], expected: { p50: 4, p95: 4, max: 4 } },
    { name: 'negative', values: [-5, -1, -9, -3, -2], expected: { p50: -3, p95: -1, max: 0 } },
    {
      name: 'mixed signs',
      values: [-2, 3, -7, 0, 11, -0.5],
      expected: { p50: -0.5, p95: 11, max: 11 }
    },
    { name: 'signed zero', values: [0, -0, -0, 0], expected: { p50: 0, p95: 0, max: 0 } },
    {
      name: 'NaN',
      values: [Number.NaN, Number.NaN],
      expected: { p50: Number.NaN, p95: Number.NaN, max: Number.NaN }
    },
    {
      name: 'positive infinity',
      values: [Infinity, 3, 1],
      expected: { p50: 3, p95: Infinity, max: Infinity }
    },
    {
      name: 'negative infinity',
      values: [-Infinity, -3, -1],
      expected: { p50: -3, p95: -1, max: 0 }
    },
    {
      name: 'both infinities',
      values: [Infinity, -Infinity, 3, -Infinity],
      expected: { p50: -Infinity, p95: Infinity, max: Infinity }
    },
    {
      name: 'rounding',
      values: [0.00049, 0.0005, 0.00051, 0.9995],
      expected: { p50: 0.001, p95: 1, max: 1 }
    }
  ])('publishes explicit p50, p95 and maximum for $name samples', ({ values, expected }) => {
    expect(summaryThroughFlush(values)).toEqual(expected)
  })

  it('leaves the caller window untouched when computing a percentile', () => {
    const samples = [5, -1, Number.NaN, 3, -0]
    const before = [...samples]
    percentile(samples, 0.5)
    expect(samples).toEqual(before)
  })
})
