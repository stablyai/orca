import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'
import {
  REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT,
  REGIONAL_REHOME_SQL_FAILURES_LIMIT,
  REGIONAL_REHOME_SQL_FAILURES_PER_CELL_LIMIT
} from './regional-rehome-safety.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

describePostgres('PostgreSQL regional rehoming', () => {
  let primary: RelayDatabase
  let secondary: RelayDatabase
  let sequence = 0

  beforeAll(async () => {
    primary = await openRelayDatabase({ databaseUrl, dataDir: '' })
    secondary = await openRelayDatabase({ databaseUrl, dataDir: '' })
  })

  beforeEach(async () => await cleanup())

  afterAll(async () => {
    await cleanup()
    await secondary.close()
    await primary.close()
  })

  async function cleanup(): Promise<void> {
    await primary.query(
      `DELETE FROM relay_region_rehome_attempts WHERE user_id LIKE 'pg-rehome-user-%'`
    )
    await primary.query(`DELETE FROM relay_region_rehome_worker_state`)
    await primary.query(`DELETE FROM relay_region_rehome_control`)
    await primary.query(
      `DELETE FROM relay_control_connection_reservations
       WHERE user_id LIKE 'pg-rehome-user-%'`
    )
    await primary.query(
      `DELETE FROM relay_assignment_migration_incarnations
       WHERE user_id LIKE 'pg-rehome-user-%'`
    )
    await primary.query(
      `DELETE FROM relay_assignment_activity_leases
       WHERE user_id LIKE 'pg-rehome-user-%'`
    )
    await primary.query(
      `DELETE FROM relay_assignment_migrations WHERE user_id LIKE 'pg-rehome-user-%'`
    )
    await primary.query(
      `DELETE FROM relay_assignment_region_preferences
       WHERE user_id LIKE 'pg-rehome-user-%'`
    )
    await primary.query(`DELETE FROM relay_assignments WHERE user_id LIKE 'pg-rehome-user-%'`)
    for (const table of [
      'relay_cell_rehome_safety',
      'relay_cell_capabilities',
      'relay_cell_connection_snapshots',
      'relay_cell_connection_runtime',
      'relay_cell_runtime',
      'relay_cell_connection_limits',
      'relay_cell_admission',
      'relay_cell_regions',
      'relay_cells'
    ]) {
      await primary.query(`DELETE FROM ${table} WHERE cell_id LIKE 'pg-rehome-cell-%'`)
    }
  }

  it('claims through ambient per-cell sql retry noise', async () => {
    const context = await fixture()
    await primary.query(
      `UPDATE relay_cell_rehome_safety
       SET sql_failures = ${REGIONAL_REHOME_SQL_FAILURES_PER_CELL_LIMIT}
       WHERE cell_id IN (?, ?)`,
      [context.source.id, context.target.id]
    )

    expect(await context.store.claimRegionalRehome()).not.toBeNull()
  })

  it('skips an unclean cell without latching the control off', async () => {
    const context = await fixture()
    await primary.query(
      `UPDATE relay_cell_rehome_safety
       SET sql_failures = ${REGIONAL_REHOME_SQL_FAILURES_PER_CELL_LIMIT + 1}
       WHERE cell_id = ?`,
      [context.target.id]
    )

    expect(await context.store.claimRegionalRehome()).toBeNull()
    expect(await context.store.inspectRegionalRehomeControl()).toMatchObject({
      generation: 1,
      enabled: true
    })
    expect(await primary.query(
      `SELECT next_dispatch_at FROM relay_region_rehome_worker_state`
    )).toEqual([{ next_dispatch_at: String(context.now() + 6_000) }])
  })

  it('lets only one director claim a host', async () => {
    const context = await fixture()
    const claims = await Promise.all([
      context.store.claimRegionalRehome(),
      context.competingStore.claimRegionalRehome()
    ])

    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await primary.query(
      `SELECT COUNT(*) AS count FROM relay_region_rehome_attempts
       WHERE user_id = ?`,
      [context.identity.userId]
    )).toEqual([{ count: '1' }])
    expect(await primary.query(
      `SELECT COUNT(*) AS count FROM relay_assignment_migrations
       WHERE user_id = ? AND completed_at IS NULL AND aborted_at IS NULL`,
      [context.identity.userId]
    )).toEqual([{ count: '1' }])
  })

  it('increments the disable generation once across competing directors', async () => {
    const context = await fixture()
    const disabled = await Promise.all([
      context.store.disableRegionalRehomeControl(),
      context.competingStore.disableRegionalRehomeControl()
    ])

    expect(disabled.sort()).toEqual([false, true])
    expect(await context.store.inspectRegionalRehomeControl()).toMatchObject({
      generation: 2,
      enabled: false
    })
  })

  it('records one receipt across competing directors', async () => {
    const context = await fixture()
    const attempt = await context.store.claimRegionalRehome()
    const receipts = await Promise.all([
      context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'accepted'),
      context.competingStore.recordRegionalRehomeDrainReceipt(
        attempt!.attemptId,
        'accepted'
      )
    ])

    expect(receipts.sort()).toEqual([false, true])
    expect(await primary.query(
      `SELECT drain_outcome FROM relay_region_rehome_attempts WHERE attempt_id = ?`,
      [attempt!.attemptId]
    )).toEqual([{ drain_outcome: 'accepted' }])
  })

  it('rechecks a preference changed while the assignment row is locked', async () => {
    const context = await fixture()
    let unlock!: () => void
    let locked!: () => void
    const lockedPromise = new Promise<void>((resolve) => (locked = resolve))
    const unlockPromise = new Promise<void>((resolve) => (unlock = resolve))
    const held = secondary.transaction(async (transaction) => {
      await transaction.queryLocked(
        `SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [context.identity.userId, context.identity.relayHostId]
      )
      locked()
      await unlockPromise
    })
    await lockedPromise
    const claim = context.store.claimRegionalRehome()
    await primary.query(
      `UPDATE relay_assignment_region_preferences SET preferred_region = 'us-central1',
         observed_at = ? WHERE user_id = ? AND relay_host_id = ?`,
      [context.now(), context.identity.userId, context.identity.relayHostId]
    )
    unlock()
    await held

    await expect(claim).resolves.toBeNull()
    expect(await primary.query(
      `SELECT COUNT(*) AS count FROM relay_assignment_migrations WHERE user_id = ?`,
      [context.identity.userId]
    )).toEqual([{ count: '0' }])
  })

  it('rechecks fleet safety under locks before mutating a candidate', async () => {
    const context = await fixture()
    let unlock!: () => void
    let locked!: () => void
    const lockedPromise = new Promise<void>((resolve) => (locked = resolve))
    const unlockPromise = new Promise<void>((resolve) => (unlock = resolve))
    const held = secondary.transaction(async (transaction) => {
      await transaction.queryLocked(
        `SELECT * FROM relay_cell_rehome_safety WHERE cell_id = ?`,
        [context.target.id]
      )
      await transaction.query(
        `UPDATE relay_cell_rehome_safety SET sql_failures = ${REGIONAL_REHOME_SQL_FAILURES_LIMIT + 1} WHERE cell_id = ?`,
        [context.target.id]
      )
      locked()
      await unlockPromise
    })
    await lockedPromise
    const claim = context.store.claimRegionalRehome()
    unlock()
    await held

    await expect(claim).resolves.toBeNull()
    expect(await context.store.inspectRegionalRehomeControl()).toMatchObject({
      generation: 2,
      enabled: false
    })
    expect(await primary.query(
      `SELECT COUNT(*) AS count FROM relay_assignment_migrations WHERE user_id = ?`,
      [context.identity.userId]
    )).toEqual([{ count: '0' }])
  })

  it('pauses when one required cell exceeds the reconnect limit', async () => {
    const context = await fixture()
    await primary.query(
      `UPDATE relay_cell_rehome_safety SET reconnects = ? WHERE cell_id = ?`,
      [REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT + 1, context.source.id]
    )

    await expect(context.store.claimRegionalRehome()).resolves.toBeNull()
    await expect(context.store.inspectRegionalRehomeControl()).resolves.toMatchObject({
      generation: 2,
      enabled: false
    })
    expect(await primary.query(
      `SELECT COUNT(*) AS count FROM relay_assignment_migrations WHERE user_id = ?`,
      [context.identity.userId]
    )).toEqual([{ count: '0' }])
  })

  it('does not retry a drain against a replacement source incarnation', async () => {
    const context = await fixture()
    const attempt = await context.store.claimRegionalRehome()
    context.advance(31_000)
    await heartbeat(
      context.store,
      context.source,
      '33333333-3333-4333-8333-333333333333',
      1,
      context.now()
    )

    await expect(context.competingStore.claimRegionalRehome()).resolves.toBeNull()
    expect(await primary.query(
      `SELECT send_attempts FROM relay_region_rehome_attempts WHERE attempt_id = ?`,
      [attempt!.attemptId]
    )).toEqual([{ send_attempts: '1' }])
  })

  it('makes concurrent completion and expiry cleanup idempotent', async () => {
    const context = await fixture()
    const attempt = await context.store.claimRegionalRehome()
    await context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'accepted')
    const targetControl = await context.store.activateControl(context.identity, {
      cellId: context.target.id,
      assignmentEpoch: attempt!.assignmentEpoch,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(context.identity, {
      cellId: context.target.id,
      assignmentEpoch: attempt!.assignmentEpoch
    })
    await context.store.releaseActivity(context.identity, context.sourceControl)
    context.advance(24 * 60 * 60_000)
    await heartbeat(
      context.store,
      context.source,
      '11111111-1111-4111-8111-111111111111',
      1,
      900_000,
      2
    )
    await heartbeat(
      context.store,
      context.target,
      '22222222-2222-4222-8222-222222222222',
      0,
      900_000,
      2
    )
    await context.store.renewControlActivity(context.identity, {
      activityId: targetControl,
      cellId: context.target.id,
      expiresAt: context.now() + 90_000
    })

    const outcomes = await Promise.all([
      context.store.completeReadyRegionalRehomes(),
      context.competingStore.abortExpiredRegionalRehomes()
    ])
    expect(outcomes).toEqual(expect.arrayContaining([0, 1]))
    expect(await primary.query(
      `SELECT completed_at IS NOT NULL AS completed, aborted_at IS NOT NULL AS aborted
       FROM relay_assignment_migrations WHERE user_id = ?`,
      [context.identity.userId]
    )).toEqual([{ completed: true, aborted: false }])
  })

  it('will not complete against a replacement target incarnation', async () => {
    const context = await fixture()
    const attempt = await context.store.claimRegionalRehome()
    await context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'accepted')
    await context.store.activateControl(context.identity, {
      cellId: context.target.id,
      assignmentEpoch: attempt!.assignmentEpoch,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(context.identity, {
      cellId: context.target.id,
      assignmentEpoch: attempt!.assignmentEpoch
    })
    await context.store.releaseActivity(context.identity, context.sourceControl)
    context.advance(1)
    await heartbeat(
      context.store,
      context.target,
      '44444444-4444-4444-8444-444444444444',
      0,
      context.now()
    )

    await expect(context.store.completeReadyRegionalRehomes()).resolves.toBe(0)
    expect(await primary.query(
      `SELECT completed_at, aborted_at FROM relay_assignment_migrations WHERE user_id = ?`,
      [context.identity.userId]
    )).toEqual([{ completed_at: null, aborted_at: null }])
  })

  it('does not roll an unregistered target back to a stale regional source', async () => {
    const context = await fixture()
    await context.store.claimRegionalRehome()
    context.advance(6 * 60_000)
    await heartbeat(
      context.store,
      context.target,
      '22222222-2222-4222-8222-222222222222',
      0,
      900_000,
      2
    )

    await expect(context.store.refreshRegionalRehomeLeases()).resolves.toBe(0)
    await expect(context.store.abortExpiredEvacuations()).resolves.toBe(0)
    expect(await primary.query(
      `SELECT cell_id, assignment_epoch FROM relay_assignments WHERE user_id = ?`,
      [context.identity.userId]
    )).toEqual([{ cell_id: context.target.id, assignment_epoch: '2' }])
  })

  it('completes after the drained host re-resolves through the director', async () => {
    const context = await fixture()
    const attempt = await context.store.claimRegionalRehome()
    await context.store.recordRegionalRehomeDrainReceipt(attempt!.attemptId, 'accepted')
    // The drain recovery lands while both controls are still live.
    await context.store.assign(context.identity, 'asia-east2')
    expect(await controlAccounting(context.identity)).toEqual({
      reservedControls: 2,
      controlLeases: 2
    })

    await context.store.activateControl(context.identity, {
      cellId: context.target.id,
      assignmentEpoch: attempt!.assignmentEpoch,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(context.identity, {
      cellId: context.target.id,
      assignmentEpoch: attempt!.assignmentEpoch
    })
    await context.store.releaseActivity(context.identity, context.sourceControl)

    await expect(context.store.completeReadyRegionalRehomes()).resolves.toBe(1)
    expect(await primary.query(
      `SELECT completed_at IS NOT NULL AS completed FROM relay_assignment_migrations
       WHERE user_id = ?`,
      [context.identity.userId]
    )).toEqual([{ completed: true }])
    expect(await controlAccounting(context.identity)).toEqual({
      reservedControls: 1,
      controlLeases: 1
    })
  })

  it('repairs a skewed control counter before completing the rehome', async () => {
    const context = await fixture()
    const attempt = await context.store.claimRegionalRehome()
    await context.store.activateControl(context.identity, {
      cellId: context.target.id,
      assignmentEpoch: attempt!.assignmentEpoch,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(context.identity, {
      cellId: context.target.id,
      assignmentEpoch: attempt!.assignmentEpoch
    })
    await context.store.releaseActivity(context.identity, context.sourceControl)
    // Damage already written by a pre-fix sticky grant.
    await primary.query(
      `UPDATE relay_assignments SET reserved_controls = 0 WHERE user_id = ?`,
      [context.identity.userId]
    )

    await expect(context.store.completeReadyRegionalRehomes()).resolves.toBe(1)
    expect(await controlAccounting(context.identity)).toEqual({
      reservedControls: 1,
      controlLeases: 1
    })
  })

  async function controlAccounting(identity: {
    userId: string
    relayHostId: string
  }): Promise<{ reservedControls: number; controlLeases: number }> {
    const assignment = (
      await primary.query(
        `SELECT reserved_controls FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    )[0]!
    const leases = await primary.query(
      `SELECT COUNT(*) AS controls FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ? AND activity_kind = 'control'`,
      [identity.userId, identity.relayHostId]
    )
    return {
      reservedControls: Number(assignment.reserved_controls),
      controlLeases: Number(leases[0]!.controls)
    }
  }

  async function fixture() {
    sequence++
    let now = 1_000_000
    const suffix = String(sequence)
    const source = cell(suffix, 'source', 'us-central1')
    const target = cell(suffix, 'target', 'asia-east2')
    const store = new RelayAssignmentStore(primary, () => now, storeOptions)
    const competingStore = new RelayAssignmentStore(secondary, () => now, storeOptions)
    await store.inspectRegionalRehomeControl()
    now += 24 * 60 * 60_000
    await store.applyRegionalRehomeControl({
      expectedGeneration: 0,
      enabled: true,
      notBefore: now,
      ratePerMinute: 10,
      preferenceMaxAgeMs: 24 * 60 * 60_000,
      drainGraceMs: 60_000
    })
    await store.reconcileCells([source, target])
    await heartbeat(
      store,
      source,
      '11111111-1111-4111-8111-111111111111',
      1,
      900_000
    )
    await heartbeat(
      store,
      target,
      '22222222-2222-4222-8222-222222222222',
      0,
      900_000
    )
    const identity = {
      userId: `pg-rehome-user-${suffix}`,
      relayHostId: `rehomehost${suffix.padStart(6, '0')}`
    }
    const assignment = await store.assign(identity, undefined, 'us-central1')
    const sourceControl = await store.activateControl(identity, {
      cellId: source.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    await store.assign(identity, 'asia-east2')
    return {
      store,
      competingStore,
      identity,
      source,
      target,
      sourceControl,
      now: () => now,
      advance: (milliseconds: number) => {
        now += milliseconds
      }
    }
  }
})

const storeOptions = {
  requireLiveCells: true,
  heartbeatTtlMs: 45_000
}

function cell(suffix: string, role: string, region: 'us-central1' | 'asia-east2') {
  return {
    id: `pg-rehome-cell-${suffix}-${role}`,
    url: `https://pg-rehome-${suffix}-${role}.example.test`,
    region,
    capacityRequests: 100,
    connectionHardCap: 1_000 as const,
    connectionUnobservedBound: 60
  }
}

async function heartbeat(
  store: RelayAssignmentStore,
  cellConfig: ReturnType<typeof cell>,
  cellIncarnation: string,
  regionalRehomeProtocol: number,
  startedAt: number,
  connectionInclusionWatermark = 1
): Promise<void> {
  await store.recordCellHeartbeat({
    cellId: cellConfig.id,
    cellUrl: cellConfig.url,
    region: cellConfig.region,
    cellIncarnation,
    startedAt,
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
    cellId: cellConfig.id,
    cellIncarnation,
    regionalRehomeProtocol,
    safety: {
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
