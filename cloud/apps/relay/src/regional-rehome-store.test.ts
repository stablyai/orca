import { describe, expect, it } from 'vitest'
import {
  RelayAssignmentStore,
  REGIONAL_REHOME_QUARANTINE_FAILURES,
  REGIONAL_REHOME_QUARANTINE_MS,
  REGIONAL_REHOME_REDRAIN_SEND_LIMIT
} from './assignment-store.js'
import { openInMemoryRelayDatabase, type RelayDatabase, type SqlRow } from './database.js'
import {
  REGIONAL_REHOME_SQL_FAILURES_LIMIT,
  REGIONAL_REHOME_SQL_FAILURES_PER_CELL_LIMIT
} from './regional-rehome-safety.js'
import type { RegionalRehomeSafetySnapshot } from './relay-observability.js'

const source = {
  id: 'us-c1',
  url: 'https://us-c1.relay.example.test',
  region: 'us-central1' as const,
  capacityRequests: 100,
  connectionHardCap: 1_000 as const,
  connectionUnobservedBound: 60
}
const target = {
  id: 'asia-c1',
  url: 'https://asia-c1.relay.example.test',
  region: 'asia-east2' as const,
  capacityRequests: 100,
  connectionHardCap: 1_000 as const,
  connectionUnobservedBound: 60
}
const sourceIncarnation = '11111111-1111-4111-8111-111111111111'
const targetIncarnation = '22222222-2222-4222-8222-222222222222'

describe('regional rehome assignment state', () => {
  it('does not open a transaction while the worker is disabled', async () => {
    const delegate = await openInMemoryRelayDatabase()
    const database = new TransactionCountingDatabase(delegate)
    const store = new RelayAssignmentStore(database, () => 1_000_000)
    await store.inspectRegionalRehomeControl()
    database.transactionCalls = 0

    await expect(store.claimRegionalRehome()).resolves.toBeNull()
    expect(database.transactionCalls).toBe(0)
    await database.close()
  })

  it('initializes a missing control row without opening a transaction', async () => {
    const delegate = await openInMemoryRelayDatabase()
    const database = new TransactionCountingDatabase(delegate)
    const store = new RelayAssignmentStore(database, () => 1_000_000)

    await expect(store.claimRegionalRehome()).resolves.toBeNull()
    expect(database.transactionCalls).toBe(0)
    await expect(store.inspectRegionalRehomeControl()).resolves.toMatchObject({
      generation: 0,
      enabled: false
    })
    await database.close()
  })

  it('uses a generation-bound durable kill switch', async () => {
    const context = await setup()
    expect(await context.store.inspectRegionalRehomeControl()).toMatchObject({
      generation: 1,
      enabled: true,
      ratePerMinute: 10
    })
    expect(await context.store.disableRegionalRehomeControl()).toBe(true)
    expect(await context.store.inspectRegionalRehomeControl()).toMatchObject({
      generation: 2,
      enabled: false
    })
    await expect(context.store.applyRegionalRehomeControl({
      expectedGeneration: 1,
      enabled: true,
      notBefore: context.now(),
      ratePerMinute: 10,
      preferenceMaxAgeMs: 24 * 60 * 60_000,
      drainGraceMs: 60_000
    })).rejects.toThrow('regional_rehome_generation_mismatch')
    await expect(context.store.applyRegionalRehomeControl({
      expectedGeneration: 2,
      enabled: true,
      notBefore: context.now(),
      ratePerMinute: 10,
      preferenceMaxAgeMs: 24 * 60 * 60_000,
      drainGraceMs: 60_000
    })).resolves.toMatchObject({ generation: 3, enabled: true })
    await context.database.close()
  })

  it('moves one live preferred host and completes without disabling its source cell', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const neighbor = { userId: 'user-2', relayHostId: 'ponmlkjihgfedcba' }
    const sourceControl = await activatePreferredSource(context, identity)
    await activateSource(context, neighbor)

    const attempt = await context.store.claimRegionalRehome()
    expect(attempt).toMatchObject({
      userId: identity.userId,
      relayHostId: identity.relayHostId,
      sourceCellId: source.id,
      sourceCellIncarnation: sourceIncarnation,
      targetCellId: target.id,
      targetCellIncarnation: targetIncarnation,
      previousEpoch: 1,
      assignmentEpoch: 2,
      sendAttempts: 1
    })
    expect(await context.store.resolve(neighbor)).toMatchObject({ cellId: source.id })
    expect(await context.store.completeReadyRegionalRehomes()).toBe(0)
    expect(
      await context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'accepted')
    ).toBe(true)
    expect(
      await context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'accepted')
    ).toBe(false)

    const targetControl = await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: 2,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: target.id,
      assignmentEpoch: 2
    })
    expect(await context.store.completeReadyRegionalRehomes()).toBe(0)
    await context.store.releaseActivity(identity, sourceControl)
    expect(await context.store.completeReadyRegionalRehomes()).toBe(1)

    expect(await context.store.resolve(identity)).toMatchObject({
      cellId: target.id,
      assignmentEpoch: 2
    })
    expect(await context.store.resolve(neighbor)).toMatchObject({ cellId: source.id })
    expect(await context.database.query(
      `SELECT completed_at, aborted_at FROM relay_assignment_migrations
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )).toEqual([{ completed_at: context.now(), aborted_at: null }])
    expect(await context.database.query(
      `SELECT completed_at, aborted_at FROM relay_region_rehome_attempts`
    )).toEqual([{ completed_at: context.now(), aborted_at: null }])
    expect(targetControl).toMatch(/^control:/)
    await context.database.close()
  })

  it('completes from durable activity when the drain response was lost', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const sourceControl = await activatePreferredSource(context, identity)
    const attempt = await context.store.claimRegionalRehome()
    await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch
    })
    await context.store.releaseActivity(identity, sourceControl)

    expect(await context.store.completeReadyRegionalRehomes()).toBe(1)
    expect(await context.database.query(
      `SELECT drain_receipt_at, completed_at, aborted_at
       FROM relay_region_rehome_attempts`
    )).toEqual([{ drain_receipt_at: null, completed_at: context.now(), aborted_at: null }])
    await context.database.close()
  })

  it('requires a fresh preference and an advertised source capability', async () => {
    const context = await setup({ sourceProtocol: 0 })
    await activatePreferredSource(context, {
      userId: 'user-1',
      relayHostId: 'abcdefghijklmnop'
    })
    expect(await context.store.claimRegionalRehome()).toBeNull()
    expect(await context.database.query(`SELECT * FROM relay_assignment_migrations`)).toEqual([])
    await context.database.close()
  })

  it('fails fleet safety closed until source and target telemetry is fresh', async () => {
    const context = await setup()
    await context.database.query(
      `DELETE FROM relay_cell_rehome_safety WHERE cell_id = ?`,
      [target.id]
    )
    expect(await context.store.regionalRehomeFleetSafety()).toMatchObject({
      requiredCells: 2,
      missingCells: 1,
      observedAt: 0
    })
    await heartbeat(context.store, source, sourceIncarnation, 1, 2, {
      observedAt: context.now(),
      sqlFailures: 0,
      reconnects: 2,
      controlActivityRecoveryFailures: 0,
      databasePoolWaiting: 0,
      databasePoolWaitersMax: 0,
      databasePoolWaitMsMax: 0
    })
    await heartbeat(context.store, target, targetIncarnation, 0, 2, {
      observedAt: context.now(),
      sqlFailures: 1,
      reconnects: 3,
      controlActivityRecoveryFailures: 0,
      databasePoolWaiting: 0,
      databasePoolWaitersMax: 0,
      databasePoolWaitMsMax: 0
    })
    expect(await context.store.regionalRehomeFleetSafety()).toMatchObject({
      requiredCells: 2,
      missingCells: 0,
      observedAt: context.now(),
      sqlFailures: 1,
      reconnects: 5
    })
    await context.database.close()
  })

  it('claims through the measured healthy baseline of pool micro-waits and churn', async () => {
    const context = await setup()
    const baseline = {
      observedAt: context.now(),
      sqlFailures: 0,
      reconnects: 42,
      controlActivityRecoveryFailures: 0,
      databasePoolWaiting: 2,
      databasePoolWaitersMax: 2,
      databasePoolWaitMsMax: 1
    }
    await heartbeat(context.store, source, sourceIncarnation, 1, 2, baseline)
    await heartbeat(context.store, target, targetIncarnation, 0, 2, baseline)
    await activatePreferredSource(context, {
      userId: 'user-1',
      relayHostId: 'abcdefghijklmnop'
    })

    expect(await context.store.claimRegionalRehome()).toMatchObject({
      sourceCellId: source.id,
      targetCellId: target.id
    })
    expect(await context.store.inspectRegionalRehomeControl()).toMatchObject({
      enabled: true
    })
    await context.database.close()
  })

  it('latches off on a per-cell reconnect storm even when the fleet sum is low', async () => {
    const context = await setup()
    await activatePreferredSource(context, {
      userId: 'user-1',
      relayHostId: 'abcdefghijklmnop'
    })
    await context.database.query(
      `UPDATE relay_cell_rehome_safety SET reconnects = 251 WHERE cell_id = ?`,
      [source.id]
    )

    const warnings = collectDisableWarnings()
    try {
      expect(await context.store.claimRegionalRehome()).toBeNull()
    } finally {
      warnings.restore()
    }
    expect(await context.store.inspectRegionalRehomeControl()).toMatchObject({
      generation: 2,
      enabled: false
    })
    expect(warnings.entries).toMatchObject([
      { reason: 'elevated_reconnects', maxReconnects: 251, controlGeneration: 2 }
    ])
    await context.database.close()
  })

  it('latches off on sustained pool pressure and logs the disable exactly once', async () => {
    const context = await setup()
    await activatePreferredSource(context, {
      userId: 'user-1',
      relayHostId: 'abcdefghijklmnop'
    })
    await context.database.query(
      `UPDATE relay_cell_rehome_safety SET database_pool_waiters_max = 17 WHERE cell_id = ?`,
      [target.id]
    )

    const warnings = collectDisableWarnings()
    try {
      expect(await context.store.claimRegionalRehome()).toBeNull()
      // Already disabled: the next tick returns before the gate and stays silent.
      expect(await context.store.claimRegionalRehome()).toBeNull()
    } finally {
      warnings.restore()
    }
    expect(await context.store.inspectRegionalRehomeControl()).toMatchObject({
      generation: 2,
      enabled: false
    })
    expect(warnings.entries).toMatchObject([
      { reason: 'database_pool_pressure', databasePoolWaitersMax: 17 }
    ])
    await context.database.close()
  })

  it('claims through ambient per-cell sql retry noise', async () => {
    const context = await setup()
    await activatePreferredSource(context, {
      userId: 'user-1',
      relayHostId: 'abcdefghijklmnop'
    })
    await context.database.query(
      `UPDATE relay_cell_rehome_safety SET sql_failures = ${REGIONAL_REHOME_SQL_FAILURES_PER_CELL_LIMIT}`
    )

    expect(await context.store.claimRegionalRehome()).not.toBeNull()
    await context.database.close()
  })

  it('skips an unclean cell without latching the control off', async () => {
    const context = await setup()
    await activatePreferredSource(context, {
      userId: 'user-1',
      relayHostId: 'abcdefghijklmnop'
    })
    await activatePreferredSource(context, {
      userId: 'user-2',
      relayHostId: 'ponmlkjihgfedcba'
    })
    // Above the per-cell cleanliness bar but below the fleet storm bar: the
    // candidate is skipped this tick while the worker stays enabled.
    await context.database.query(
      `UPDATE relay_cell_rehome_safety SET sql_failures = ${REGIONAL_REHOME_SQL_FAILURES_PER_CELL_LIMIT + 1} WHERE cell_id = ?`,
      [target.id]
    )

    const warnings = collectEventWarnings('orca_relay_regional_rehome_candidates_skipped')
    try {
      expect(await context.store.claimRegionalRehome()).toBeNull()
    } finally {
      warnings.restore()
    }
    expect(await context.store.inspectRegionalRehomeControl()).toMatchObject({
      generation: 1,
      enabled: true
    })
    // The skip is visible and named, and both candidates blocked by the one
    // unclean cell accumulate into a single entry.
    expect(warnings.entries).toMatchObject([
      {
        skips: [
          {
            reason: 'target_unclean',
            cellId: target.id,
            sqlFailures: REGIONAL_REHOME_SQL_FAILURES_PER_CELL_LIMIT + 1,
            candidates: 2
          }
        ]
      }
    ])
    // A skipped tick is charged the dispatch interval: candidate scans stay
    // rate-limited even when nothing claims.
    expect(
      await context.database.query(
        `SELECT next_dispatch_at FROM relay_region_rehome_worker_state`
      )
    ).toEqual([{ next_dispatch_at: context.now() + 6_000 }])
    expect(await context.database.query(`SELECT * FROM relay_assignment_migrations`)).toEqual([])
    await context.database.close()
  })

  it('does not throttle or log an idle tick with no candidates', async () => {
    const context = await setup()

    const warnings = collectEventWarnings('orca_relay_regional_rehome_candidates_skipped')
    try {
      expect(await context.store.claimRegionalRehome()).toBeNull()
    } finally {
      warnings.restore()
    }
    expect(warnings.entries).toEqual([])
    expect(
      await context.database.query(
        `SELECT next_dispatch_at FROM relay_region_rehome_worker_state`
      )
    ).toEqual([{ next_dispatch_at: 0 }])
    await context.database.close()
  })

  it('atomically latches durable control off when candidate safety changes', async () => {
    const context = await setup()
    await activatePreferredSource(context, {
      userId: 'user-1',
      relayHostId: 'abcdefghijklmnop'
    })
    await context.database.query(
      `UPDATE relay_cell_rehome_safety SET sql_failures = ${REGIONAL_REHOME_SQL_FAILURES_LIMIT + 1} WHERE cell_id = ?`,
      [target.id]
    )

    expect(await context.store.claimRegionalRehome()).toBeNull()
    expect(await context.store.inspectRegionalRehomeControl()).toMatchObject({
      generation: 2,
      enabled: false
    })
    expect(await context.database.query(`SELECT * FROM relay_assignment_migrations`)).toEqual([])
    await context.database.close()
  })

  it('rechecks locked fleet safety before retrying a drain dispatch', async () => {
    const context = await setup()
    await activatePreferredSource(context, {
      userId: 'user-1',
      relayHostId: 'abcdefghijklmnop'
    })
    expect(await context.store.claimRegionalRehome()).not.toBeNull()
    context.advance(31_000)
    await context.database.query(
      `UPDATE relay_cell_rehome_safety SET sql_failures = ${REGIONAL_REHOME_SQL_FAILURES_LIMIT + 1} WHERE cell_id = ?`,
      [target.id]
    )

    expect(await context.store.claimRegionalRehome()).toBeNull()
    expect(await context.store.inspectRegionalRehomeControl()).toMatchObject({
      generation: 2,
      enabled: false
    })
    await context.database.close()
  })

  it('latches off after three dispatch failures and resumes only through CAS', async () => {
    const context = await setup()
    await activatePreferredSource(context, {
      userId: 'user-1',
      relayHostId: 'abcdefghijklmnop'
    })
    const first = await context.store.claimRegionalRehome()
    for (let index = 0; index < 3; index++) {
      await context.store.recordRegionalRehomeDispatchFailure(first!.attemptId)
    }
    context.advance(5 * 60_000 - 1)
    expect(await context.store.claimRegionalRehome()).toBeNull()
    context.advance(1)
    await heartbeat(context.store, source, sourceIncarnation, 1, 2, {
      observedAt: context.now(),
      sqlFailures: 0,
      reconnects: 0,
      controlActivityRecoveryFailures: 0,
      databasePoolWaiting: 0,
      databasePoolWaitersMax: 0,
      databasePoolWaitMsMax: 0
    })
    await heartbeat(context.store, target, targetIncarnation, 0, 2, {
      observedAt: context.now(),
      sqlFailures: 0,
      reconnects: 0,
      controlActivityRecoveryFailures: 0,
      databasePoolWaiting: 0,
      databasePoolWaitersMax: 0,
      databasePoolWaitMsMax: 0
    })
    expect(await context.store.claimRegionalRehome()).toBeNull()
    expect(await context.store.inspectRegionalRehomeControl()).toMatchObject({
      generation: 2,
      enabled: false
    })
    await context.store.applyRegionalRehomeControl({
      expectedGeneration: 2,
      enabled: true,
      notBefore: context.now(),
      ratePerMinute: 10,
      preferenceMaxAgeMs: 24 * 60 * 60_000,
      drainGraceMs: 60_000
    })
    const retry = await context.store.claimRegionalRehome()
    expect(retry).toMatchObject({ attemptId: first!.attemptId, sendAttempts: 2 })
    expect(await context.database.query(
      `SELECT COUNT(*) AS count FROM relay_assignment_migrations`
    )).toEqual([{ count: 1 }])
    await context.database.close()
  })

  it('refreshes only the migration leases while source splices drain', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    await activatePreferredSource(context, identity)
    await context.store.acquireActivity(identity, {
      activityId: 'splice:source',
      kind: 'splice',
      cellId: source.id
    })
    await context.store.claimRegionalRehome()
    const before = await context.database.query(
      `SELECT activity_id, expires_at FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ? ORDER BY activity_id`,
      [identity.userId, identity.relayHostId]
    )
    context.advance(60_000)
    expect(await context.store.refreshRegionalRehomeLeases()).toBe(1)
    const after = await context.database.query(
      `SELECT activity_id, expires_at FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ? ORDER BY activity_id`,
      [identity.userId, identity.relayHostId]
    )
    const beforeById = new Map(before.map((row) => [row.activity_id, row.expires_at]))
    const afterById = new Map(after.map((row) => [row.activity_id, row.expires_at]))
    expect(Number(afterById.get('migration:2'))).toBeGreaterThan(
      Number(beforeById.get('migration:2'))
    )
    expect(Number(afterById.get('control-pending:2'))).toBeGreaterThan(
      Number(beforeById.get('control-pending:2'))
    )
    expect(afterById.get('splice:source')).toBe(beforeById.get('splice:source'))
    await context.database.close()
  })

  it('stops refreshing an unregistered target and lets normal rollback retire it', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    await activatePreferredSource(context, identity)
    await context.store.claimRegionalRehome()
    context.advance(6 * 60_000)
    expect(await context.store.refreshRegionalRehomeLeases()).toBe(0)
    await heartbeat(context.store, source, sourceIncarnation, 1, 2)
    expect(await context.store.abortExpiredEvacuations()).toBe(1)
    expect(await context.store.reapRegionalRehomeAttempts()).toBe(1)
    expect(await context.store.resolve(identity)).toMatchObject({
      cellId: source.id,
      assignmentEpoch: 3
    })
    expect(await context.database.query(
      `SELECT completed_at, aborted_at FROM relay_region_rehome_attempts`
    )).toEqual([{ completed_at: null, aborted_at: context.now() }])
    await context.database.close()
  })

  it('does not roll an unregistered target back to a stale regional source', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    await activatePreferredSource(context, identity)
    await context.store.claimRegionalRehome()
    context.advance(6 * 60_000)
    await heartbeat(context.store, target, targetIncarnation, 0, 2)

    expect(await context.store.refreshRegionalRehomeLeases()).toBe(0)
    expect(await context.store.abortExpiredEvacuations()).toBe(0)
    expect(
      await context.database.query(
        `SELECT cell_id, assignment_epoch FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ cell_id: target.id, assignment_epoch: 2 }])
    await context.database.close()
  })

  it('rolls back an inactive registered target only after the 24-hour bound', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const sourceControl = await activatePreferredSource(context, identity)
    const attempt = await context.store.claimRegionalRehome()
    await context.store.recordRegionalRehomeDrainReceipt(
      attempt!.attemptId,
      'accepted'
    )
    const targetControl = await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: 2,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: target.id,
      assignmentEpoch: 2
    })
    await context.store.releaseActivity(identity, sourceControl)
    await context.store.releaseActivity(identity, targetControl)
    context.advance(24 * 60 * 60_000)
    await heartbeat(context.store, source, sourceIncarnation, 1, 2)
    expect(await context.store.abortExpiredRegionalRehomes()).toBe(1)
    expect(await context.store.resolve(identity)).toMatchObject({
      cellId: source.id,
      assignmentEpoch: 3
    })
    await context.database.close()
  })

  it('redrains a receipted dual-homed attempt once its grace elapses', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const sourceControl = await activatePreferredSource(context, identity)
    const attempt = await context.store.claimRegionalRehome()
    await context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'accepted')
    await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: 2,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: target.id,
      assignmentEpoch: 2
    })

    // Before grace elapses a receipted attempt is not re-dispatched.
    context.advance(30 * 60_000)
    await freshHeartbeats(context)
    expect(await context.store.claimRegionalRehome()).toBeNull()

    context.advance(30 * 60_000 + 1)
    await freshHeartbeats(context)
    const redrain = await context.store.claimRegionalRehome()
    expect(redrain).toMatchObject({
      attemptId: attempt!.attemptId,
      drainGraceMs: 0,
      sendAttempts: 2
    })
    // The per-dispatch receipt replaces the original without a mismatch.
    await expect(
      context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'host-not-connected')
    ).resolves.toBe(true)

    // Redrains are spaced: nothing new inside the redrain interval.
    context.advance(30_000)
    await freshHeartbeats(context)
    expect(await context.store.claimRegionalRehome()).toBeNull()
    context.advance(30_001)
    await freshHeartbeats(context)
    expect(await context.store.claimRegionalRehome()).toMatchObject({
      attemptId: attempt!.attemptId,
      drainGraceMs: 0,
      sendAttempts: 3
    })

    // Once the host actually leaves the source, completion wins over redrain.
    await context.store.releaseActivity(identity, sourceControl)
    context.advance(60_001)
    await freshHeartbeats(context)
    await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: 2,
      generation: 2
    })
    expect(await context.store.claimRegionalRehome()).toBeNull()
    expect(await context.store.completeReadyRegionalRehomes()).toBe(1)
    await context.database.close()
  })

  it('resets the failure budget on a repeated redrain receipt outcome', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    await activatePreferredSource(context, identity)
    const attempt = await context.store.claimRegionalRehome()
    await context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'accepted')
    await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: 2,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: target.id,
      assignmentEpoch: 2
    })
    await context.store.recordRegionalRehomeDispatchFailure(attempt!.attemptId)
    await context.store.recordRegionalRehomeDispatchFailure(attempt!.attemptId)

    context.advance(60 * 60_000 + 1)
    await freshHeartbeats(context)
    expect(await context.store.claimRegionalRehome()).toMatchObject({
      attemptId: attempt!.attemptId,
      drainGraceMs: 0
    })
    // The repeated outcome still proves the source answered.
    expect(
      await context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'accepted')
    ).toBe(false)
    await context.store.recordRegionalRehomeDispatchFailure(attempt!.attemptId)
    expect(await context.store.inspectRegionalRehomeControl()).toMatchObject({
      generation: 1,
      enabled: true
    })
    await context.database.close()
  })

  it('does not redrain before the target registers or when the fleet is unsafe', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    await activatePreferredSource(context, identity)
    const attempt = await context.store.claimRegionalRehome()
    await context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'accepted')
    await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: 2,
      generation: 1
    })

    // Past grace but the target never registered: force-closing the source
    // would disconnect the host with nowhere proven to land.
    context.advance(60 * 60_000 + 1)
    await freshHeartbeats(context)
    expect(await context.store.claimRegionalRehome()).toBeNull()

    await context.store.markMigrationTargetRegistered(identity, {
      cellId: target.id,
      assignmentEpoch: 2
    })
    await context.database.query(
      `UPDATE relay_cell_rehome_safety SET sql_failures = ${REGIONAL_REHOME_SQL_FAILURES_LIMIT + 1} WHERE cell_id = ?`,
      [target.id]
    )
    expect(await context.store.claimRegionalRehome()).toBeNull()
    expect(await context.store.inspectRegionalRehomeControl()).toMatchObject({
      enabled: false
    })
    await context.database.close()
  })

  it('completes healthy candidates past a poisoned attempt and logs it', async () => {
    const context = await setup()
    const poisoned = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const healthy = { userId: 'user-2', relayHostId: 'ponmlkjihgfedcba' }
    const poisonedSource = await activatePreferredSource(context, poisoned)
    const healthySource = await activatePreferredSource(context, healthy)
    const first = await context.store.claimRegionalRehome()
    context.advance(6_000)
    const second = await context.store.claimRegionalRehome()
    expect(first!.userId).toBe(poisoned.userId)
    expect(second!.userId).toBe(healthy.userId)
    for (const [identity, attempt, sourceControl] of [
      [poisoned, first, poisonedSource],
      [healthy, second, healthySource]
    ] as const) {
      await context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'accepted')
      await context.store.activateControl(identity, {
        cellId: target.id,
        assignmentEpoch: attempt!.assignmentEpoch,
        generation: 1
      })
      await context.store.markMigrationTargetRegistered(identity, {
        cellId: target.id,
        assignmentEpoch: attempt!.assignmentEpoch
      })
      await context.store.releaseActivity(identity, sourceControl)
    }
    // The production poison shape: the assignment moved past the attempt.
    await context.database.query(
      `UPDATE relay_assignments SET assignment_epoch = assignment_epoch + 5
       WHERE user_id = ?`,
      [poisoned.userId]
    )
    const warnings = collectCandidateFailureWarnings()
    try {
      expect(await context.store.completeReadyRegionalRehomes()).toBe(1)
    } finally {
      warnings.restore()
    }
    expect(warnings.entries).toEqual([
      {
        event: 'orca_relay_regional_rehome_candidate_failed',
        operation: 'complete',
        attemptId: first!.attemptId,
        reason: 'regional_rehome_assignment_mismatch'
      }
    ])
    expect(await context.database.query(
      `SELECT completed_at FROM relay_region_rehome_attempts WHERE attempt_id = ?`,
      [second!.attemptId]
    )).toEqual([{ completed_at: context.now() }])
    await context.database.close()
  })

  it('quarantines a repeatedly failing candidate and redacts free-form errors', async () => {
    const context = await setup()
    const poisoned = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const source1 = await activatePreferredSource(context, poisoned)
    const attempt = await context.store.claimRegionalRehome()
    await context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'accepted')
    await context.store.activateControl(poisoned, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(poisoned, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch
    })
    await context.store.releaseActivity(poisoned, source1)
    await context.database.query(
      `UPDATE relay_assignments SET assignment_epoch = assignment_epoch + 5
       WHERE user_id = ?`,
      [poisoned.userId]
    )
    const warnings = collectCandidateFailureWarnings()
    try {
      for (let round = 0; round < REGIONAL_REHOME_QUARANTINE_FAILURES; round++) {
        expect(await context.store.completeReadyRegionalRehomes()).toBe(0)
      }
      expect(warnings.entries).toHaveLength(REGIONAL_REHOME_QUARANTINE_FAILURES)
      // Quarantined: the poisoned row leaves the candidate page entirely.
      expect(await context.store.completeReadyRegionalRehomes()).toBe(0)
      expect(warnings.entries).toHaveLength(REGIONAL_REHOME_QUARANTINE_FAILURES)
      // After the quarantine window it is retried (and fails) once more.
      context.advance(REGIONAL_REHOME_QUARANTINE_MS + 1)
      await context.store.completeReadyRegionalRehomes()
      expect(warnings.entries).toHaveLength(REGIONAL_REHOME_QUARANTINE_FAILURES + 1)
      // A free-form error (never a slug) reaches the log only as 'redacted'.
      expect(
        warnings.entries.every(
          (entry) => entry.reason === 'regional_rehome_assignment_mismatch'
        )
      ).toBe(true)
      context.advance(REGIONAL_REHOME_QUARANTINE_MS + 1)
      const database = context.database
      const original = database.transaction.bind(database)
      database.transaction = () => {
        throw new Error('postgresql://secret@database.invalid/relay')
      }
      try {
        await context.store.completeReadyRegionalRehomes()
      } finally {
        database.transaction = original
      }
      const last = warnings.entries.at(-1)!
      expect(last.reason).toBe('redacted')
      expect(JSON.stringify(last)).not.toContain('secret')
    } finally {
      warnings.restore()
    }
    await context.database.close()
  })

  it('aborts healthy expired candidates past a poisoned attempt', async () => {
    const context = await setup()
    const poisoned = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const healthy = { userId: 'user-2', relayHostId: 'ponmlkjihgfedcba' }
    const poisonedSource = await activatePreferredSource(context, poisoned)
    const healthySource = await activatePreferredSource(context, healthy)
    const first = await context.store.claimRegionalRehome()
    context.advance(6_000)
    const second = await context.store.claimRegionalRehome()
    for (const [identity, attempt, sourceControl] of [
      [poisoned, first, poisonedSource],
      [healthy, second, healthySource]
    ] as const) {
      await context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'accepted')
      const targetControl = await context.store.activateControl(identity, {
        cellId: target.id,
        assignmentEpoch: attempt!.assignmentEpoch,
        generation: 1
      })
      await context.store.markMigrationTargetRegistered(identity, {
        cellId: target.id,
        assignmentEpoch: attempt!.assignmentEpoch
      })
      await context.store.releaseActivity(identity, sourceControl)
      await context.store.releaseActivity(identity, targetControl)
    }
    await context.database.query(
      `UPDATE relay_assignments SET assignment_epoch = assignment_epoch + 5
       WHERE user_id = ?`,
      [poisoned.userId]
    )
    context.advance(24 * 60 * 60_000)
    await freshHeartbeats(context)
    const warnings = collectCandidateFailureWarnings()
    try {
      expect(await context.store.abortExpiredRegionalRehomes()).toBe(1)
    } finally {
      warnings.restore()
    }
    expect(warnings.entries).toEqual([
      {
        event: 'orca_relay_regional_rehome_candidate_failed',
        operation: 'abort',
        attemptId: first!.attemptId,
        reason: 'regional_rehome_assignment_mismatch'
      }
    ])
    expect(await context.database.query(
      `SELECT aborted_at FROM relay_region_rehome_attempts WHERE attempt_id = ?`,
      [second!.attemptId]
    )).toEqual([{ aborted_at: context.now() }])
    await context.database.close()
  })

  it('keeps dual-control accounting when the drained host re-resolves mid-rehome', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const sourceControl = await activatePreferredSource(context, identity)
    const attempt = await context.store.claimRegionalRehome()
    expect(await controlAccounting(context, identity)).toEqual({
      reservedControls: 2,
      controlLeases: 2
    })

    // The drained host re-resolves through the director while both the source
    // control and the target's pending control are still live.
    await context.store.assign(identity, 'asia-east2')
    expect(await controlAccounting(context, identity)).toEqual({
      reservedControls: 2,
      controlLeases: 2
    })

    await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch
    })
    await context.store.releaseActivity(identity, sourceControl)
    expect(await controlAccounting(context, identity)).toEqual({
      reservedControls: 1,
      controlLeases: 1
    })

    expect(await context.store.completeReadyRegionalRehomes()).toBe(1)
    expect(await context.database.query(
      `SELECT completed_at FROM relay_assignment_migrations
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )).toEqual([{ completed_at: context.now() }])
    expect(await cellReservations(context)).toEqual({ [source.id]: 0, [target.id]: 1 })
    await context.database.close()
  })

  it('grants a host whose counter was skewed without duplicating its control', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const sourceControl = await activatePreferredSource(context, identity)
    const attempt = await context.store.claimRegionalRehome()
    await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch,
      generation: 1
    })
    await context.store.releaseActivity(identity, sourceControl)
    // Damage already written by a pre-fix sticky grant.
    await context.database.query(
      `UPDATE relay_assignments SET reserved_controls = 0
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )

    await context.store.assign(identity, 'asia-east2')
    expect(await context.database.query(
      `SELECT activity_id FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ? AND activity_kind = 'control'`,
      [identity.userId, identity.relayHostId]
    )).toEqual([{ activity_id: `control:${target.id}:1` }])
    expect(await cellReservations(context)).toEqual({ [source.id]: 0, [target.id]: 2 })
    await context.database.close()
  })

  it('repairs a skewed control counter before completing the rehome', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const sourceControl = await activatePreferredSource(context, identity)
    const attempt = await context.store.claimRegionalRehome()
    await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch
    })
    await context.store.releaseActivity(identity, sourceControl)
    // Damage already written by a pre-fix sticky grant.
    await context.database.query(
      `UPDATE relay_assignments SET reserved_controls = 0
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )

    expect(await context.store.completeReadyRegionalRehomes()).toBe(1)
    expect(await controlAccounting(context, identity)).toEqual({
      reservedControls: 1,
      controlLeases: 1
    })
    expect(await context.database.query(
      `SELECT migration_leases FROM relay_assignments
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )).toEqual([{ migration_leases: 0 }])
    await context.database.close()
  })

  it('reports a repaired counter only for the candidate it repaired', async () => {
    const context = await setup()
    const skewed = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const clean = { userId: 'user-2', relayHostId: 'ponmlkjihgfedcba' }
    const skewedSource = await activatePreferredSource(context, skewed)
    const cleanSource = await activatePreferredSource(context, clean)
    const first = await context.store.claimRegionalRehome()
    context.advance(6_000)
    const second = await context.store.claimRegionalRehome()
    for (const [identity, attempt, sourceControl] of [
      [skewed, first, skewedSource],
      [clean, second, cleanSource]
    ] as const) {
      await context.store.activateControl(identity, {
        cellId: target.id,
        assignmentEpoch: attempt!.assignmentEpoch,
        generation: 1
      })
      await context.store.markMigrationTargetRegistered(identity, {
        cellId: target.id,
        assignmentEpoch: attempt!.assignmentEpoch
      })
      await context.store.releaseActivity(identity, sourceControl)
    }
    // Damage already written by a pre-fix sticky grant, on one host only.
    await context.database.query(
      `UPDATE relay_assignments SET reserved_controls = 0
       WHERE user_id = ? AND relay_host_id = ?`,
      [skewed.userId, skewed.relayHostId]
    )

    const warnings = collectCandidateFailureWarnings([
      'orca_relay_regional_rehome_activity_counts_repaired'
    ])
    try {
      expect(await context.store.completeReadyRegionalRehomes()).toBe(2)
    } finally {
      warnings.restore()
    }
    expect(warnings.entries).toEqual([
      {
        event: 'orca_relay_regional_rehome_activity_counts_repaired',
        attemptId: first!.attemptId
      }
    ])
    await context.database.close()
  })

  it('never repairs past a migration lease whose shape is wrong', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const sourceControl = await activatePreferredSource(context, identity)
    const attempt = await context.store.claimRegionalRehome()
    await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch
    })
    await context.store.releaseActivity(identity, sourceControl)
    await context.database.query(
      `UPDATE relay_assignments SET reserved_controls = 0
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    await context.database.query(
      `UPDATE relay_assignment_migrations SET target_reserved_units = 9
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )

    const warnings = collectCandidateFailureWarnings()
    try {
      expect(await context.store.completeReadyRegionalRehomes()).toBe(0)
    } finally {
      warnings.restore()
    }
    expect(warnings.entries).toEqual([
      {
        event: 'orca_relay_regional_rehome_candidate_failed',
        operation: 'complete',
        attemptId: attempt!.attemptId,
        reason: 'migration_activity_lease_shape_mismatch'
      }
    ])
    expect(await controlAccounting(context, identity)).toEqual({
      reservedControls: 0,
      controlLeases: 1
    })
    await context.database.close()
  })

  it('stays silent when a repair cannot make the counts whole', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const sourceControl = await activatePreferredSource(context, identity)
    const attempt = await context.store.claimRegionalRehome()
    await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: target.id,
      assignmentEpoch: attempt!.assignmentEpoch
    })
    await context.store.releaseActivity(identity, sourceControl)
    // A vanished migration lease is repairable arithmetic on the first assert
    // but still wrong on the re-assert: no repaired event may leak out.
    await context.database.query(
      `DELETE FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ? AND activity_kind = 'migration'`,
      [identity.userId, identity.relayHostId]
    )

    const warnings = collectCandidateFailureWarnings([
      'orca_relay_regional_rehome_candidate_failed',
      'orca_relay_regional_rehome_activity_counts_repaired'
    ])
    try {
      expect(await context.store.completeReadyRegionalRehomes()).toBe(0)
    } finally {
      warnings.restore()
    }
    expect(warnings.entries).toEqual([
      {
        event: 'orca_relay_regional_rehome_candidate_failed',
        operation: 'complete',
        attemptId: attempt!.attemptId,
        reason: 'migration_activity_accounting_mismatch'
      }
    ])
    await context.database.close()
  })

  it('caps redrain dispatches at the send limit', async () => {
    const context = await setup()
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    await activatePreferredSource(context, identity)
    const attempt = await context.store.claimRegionalRehome()
    await context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'accepted')
    await context.store.activateControl(identity, {
      cellId: target.id,
      assignmentEpoch: 2,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: target.id,
      assignmentEpoch: 2
    })
    await context.database.query(
      `UPDATE relay_region_rehome_attempts SET send_attempts = ? WHERE attempt_id = ?`,
      [REGIONAL_REHOME_REDRAIN_SEND_LIMIT, attempt!.attemptId]
    )
    context.advance(60 * 60_000 + 1)
    await freshHeartbeats(context)
    expect(await context.store.claimRegionalRehome()).toBeNull()
    await context.database.close()
  })
})

class TransactionCountingDatabase implements RelayDatabase {
  transactionCalls = 0

  constructor(private readonly delegate: RelayDatabase) {}

  query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    return this.delegate.query(sql, params)
  }

  queryLocked(
    sql: string,
    params?: unknown[],
    options?: { failIfUnavailable?: boolean }
  ): Promise<SqlRow[]> {
    return this.delegate.queryLocked(sql, params, options)
  }

  transaction<T>(
    operation: (transaction: RelayDatabase) => Promise<T>,
    options?: { reportRetries?: boolean }
  ): Promise<T> {
    this.transactionCalls += 1
    return this.delegate.transaction(operation, options)
  }

  close(): Promise<void> {
    return this.delegate.close()
  }
}

type Context = Awaited<ReturnType<typeof setup>>

function collectDisableWarnings() {
  const entries: Record<string, unknown>[] = []
  const original = console.warn
  console.warn = (line: unknown, ...rest: unknown[]) => {
    try {
      const parsed = JSON.parse(line as string) as Record<string, unknown>
      if (parsed.event === 'orca_relay_regional_rehome_safety_disabled') {
        entries.push(parsed)
        return
      }
    } catch {
      // fall through to the real console for non-JSON lines
    }
    original(line, ...rest)
  }
  return {
    entries,
    restore: () => {
      console.warn = original
    }
  }
}

async function setup(options: { sourceProtocol?: number } = {}) {
  let clock = 1_000_000
  const database = await openInMemoryRelayDatabase()
  const store = new RelayAssignmentStore(database, () => clock, {
    requireLiveCells: true,
    heartbeatTtlMs: 45_000
  })
  await store.inspectRegionalRehomeControl()
  clock += 24 * 60 * 60_000
  await store.applyRegionalRehomeControl({
    expectedGeneration: 0,
    enabled: true,
    notBefore: clock,
    ratePerMinute: 10,
    preferenceMaxAgeMs: 24 * 60 * 60_000,
    drainGraceMs: 60 * 60_000
  })
  await store.reconcileCells([source, target])
  await heartbeat(store, source, sourceIncarnation, options.sourceProtocol ?? 1)
  await heartbeat(store, target, targetIncarnation, 0)
  return {
    database,
    store,
    now: () => clock,
    advance: (milliseconds: number) => {
      clock += milliseconds
    }
  }
}

function collectEventWarnings(event: string) {
  const entries: Record<string, unknown>[] = []
  const original = console.warn
  console.warn = (line: unknown, ...rest: unknown[]) => {
    try {
      const parsed = JSON.parse(line as string) as Record<string, unknown>
      if (parsed.event === event) {
        entries.push(parsed)
        return
      }
    } catch {
      // fall through to the real console for non-JSON lines
    }
    original(line, ...rest)
  }
  return {
    entries,
    restore: () => {
      console.warn = original
    }
  }
}

function collectCandidateFailureWarnings(
  events: string[] = ['orca_relay_regional_rehome_candidate_failed']
) {
  const entries: Record<string, unknown>[] = []
  const original = console.warn
  console.warn = (line: unknown, ...rest: unknown[]) => {
    try {
      const parsed = JSON.parse(line as string) as Record<string, unknown>
      if (events.includes(parsed.event as string)) {
        entries.push(parsed)
        return
      }
    } catch {
      // fall through to the real console for non-JSON lines
    }
    original(line, ...rest)
  }
  return {
    entries,
    restore: () => {
      console.warn = original
    }
  }
}

async function controlAccounting(
  context: Context,
  identity: { userId: string; relayHostId: string }
): Promise<{ reservedControls: number; controlLeases: number }> {
  const assignment = (
    await context.database.query(
      `SELECT reserved_controls FROM relay_assignments
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
  )[0]!
  const leases = await context.database.query(
    `SELECT COUNT(*) AS controls FROM relay_assignment_activity_leases
     WHERE user_id = ? AND relay_host_id = ? AND activity_kind = 'control'`,
    [identity.userId, identity.relayHostId]
  )
  return {
    reservedControls: Number(assignment.reserved_controls),
    controlLeases: Number(leases[0]!.controls)
  }
}

async function cellReservations(context: Context): Promise<Record<string, number>> {
  const rows = await context.database.query(
    `SELECT cell_id, reserved_requests FROM relay_cells ORDER BY cell_id`
  )
  return Object.fromEntries(
    rows.map((row) => [String(row.cell_id), Number(row.reserved_requests)])
  )
}

async function freshHeartbeats(context: Context): Promise<void> {
  const safety = {
    observedAt: context.now(),
    sqlFailures: 0,
    reconnects: 0,
    controlActivityRecoveryFailures: 0,
    databasePoolWaiting: 0,
    databasePoolWaitersMax: 0,
    databasePoolWaitMsMax: 0
  }
  // The clock doubles as a strictly-increasing connection inclusion watermark.
  await heartbeat(context.store, source, sourceIncarnation, 1, context.now(), safety)
  await heartbeat(context.store, target, targetIncarnation, 0, context.now(), safety)
}

async function activatePreferredSource(
  context: Context,
  identity: { userId: string; relayHostId: string }
): Promise<string> {
  const assignment = await context.store.assign(identity, undefined, 'us-central1')
  const control = await context.store.activateControl(identity, {
    cellId: source.id,
    assignmentEpoch: assignment.assignmentEpoch,
    generation: 1
  })
  await context.store.assign(identity, 'asia-east2')
  return control
}

async function activateSource(
  context: Context,
  identity: { userId: string; relayHostId: string }
): Promise<string> {
  const assignment = await context.store.assign(identity, undefined, 'us-central1')
  return await context.store.activateControl(identity, {
    cellId: source.id,
    assignmentEpoch: assignment.assignmentEpoch,
    generation: 1
  })
}

async function heartbeat(
  store: RelayAssignmentStore,
  cell: typeof source | typeof target,
  cellIncarnation: string,
  regionalRehomeProtocol: number,
  connectionInclusionWatermark = 1,
  regionalRehomeSafety?: RegionalRehomeSafetySnapshot
): Promise<void> {
  await store.recordCellHeartbeat({
    cellId: cell.id,
    cellUrl: cell.url,
    region: cell.region,
    cellIncarnation,
    startedAt: 900_000,
    ready: true,
    observedRequests: 0,
    totalConnections: 0,
    inFlightConnections: 0,
    reservedConnectionUnits: 0,
    enforcedConnectionUnits: 0,
    connectionInclusionWatermark,
    connectionHardCap: 1_000,
    connectionUnobservedBound: 60
  })
  await store.recordCellRegionalRehomeStatus({
    cellId: cell.id,
    cellIncarnation,
    regionalRehomeProtocol,
    safety: regionalRehomeSafety ?? {
      observedAt: 1_000_000 + 24 * 60 * 60_000,
      sqlFailures: 0,
      reconnects: 0,
      controlActivityRecoveryFailures: 0,
      databasePoolWaiting: 0,
      databasePoolWaitersMax: 0,
      databasePoolWaitMsMax: 0
    }
  })
}
