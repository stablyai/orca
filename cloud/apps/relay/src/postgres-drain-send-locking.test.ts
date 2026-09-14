import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const source = {
  id: 'drain-send-lock-source',
  url: 'https://drain-send-lock-source.example.com',
  capacityRequests: 100
}
const target = {
  id: 'drain-send-lock-target',
  url: 'https://drain-send-lock-target.example.com',
  capacityRequests: 100
}
const identity = {
  userId: 'drain-send-lock-user',
  relayHostId: 'drainsendlock01'
}
const sourceIncarnation = '11111111-1111-4111-8111-111111111111'
const targetIncarnation = '22222222-2222-4222-8222-222222222222'
const attemptId = '33333333-3333-4333-8333-333333333333'

describePostgres('PostgreSQL drain-send locking', () => {
  let database: RelayDatabase

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '' })
  })

  afterAll(async () => await database.close())

  afterEach(async () => {
    await database.query(`DELETE FROM relay_post_drain_migration_pins WHERE user_id = ?`, [
      identity.userId
    ])
    await database.query(`DELETE FROM relay_cell_drain_attempt_states WHERE attempt_id = ?`, [
      attemptId
    ])
    await database.query(
      `DELETE FROM relay_control_connection_reservations WHERE user_id = ?`,
      [identity.userId]
    )
    await database.query(`DELETE FROM relay_migration_leases WHERE user_id = ?`, [
      identity.userId
    ])
    await database.query(`DELETE FROM relay_assignment_activity_leases WHERE user_id = ?`, [
      identity.userId
    ])
    await database.query(
      `DELETE FROM relay_assignment_migration_incarnations WHERE user_id = ?`,
      [identity.userId]
    )
    await database.query(`DELETE FROM relay_assignment_migrations WHERE user_id = ?`, [
      identity.userId
    ])
    await database.query(`DELETE FROM relay_assignments WHERE user_id = ?`, [identity.userId])
    await database.query(`DELETE FROM relay_cell_runtime WHERE cell_id IN (?, ?)`, [
      source.id,
      target.id
    ])
    await database.query(`DELETE FROM relay_cell_admission WHERE cell_id IN (?, ?)`, [
      source.id,
      target.id
    ])
    await database.query(`DELETE FROM relay_cells WHERE cell_id IN (?, ?)`, [
      source.id,
      target.id
    ])
  })

  it('locks active migrations without locking the nullable incarnation lookup', async () => {
    const now = 1_700_000_000_000
    const store = new RelayAssignmentStore(database, () => now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    await store.reconcileCells([source, target])
    await store.recordCellHeartbeat({
      cellId: source.id,
      cellUrl: source.url,
      cellIncarnation: sourceIncarnation,
      startedAt: now - 1,
      ready: true,
      observedRequests: 0
    })
    await store.recordCellHeartbeat({
      cellId: target.id,
      cellUrl: target.url,
      cellIncarnation: targetIncarnation,
      startedAt: now - 1,
      ready: true,
      observedRequests: 0
    })
    await store.assign(identity)
    await store.setCellEnabled(source.id, false)
    await store.startEvacuation(identity, target.id)
    await store.prepareCellDrainAttempt({
      attemptId,
      cellId: source.id,
      cellIncarnation: sourceIncarnation,
      traceValue: '44444444-4444-4444-8444-444444444444',
      plannedGraceMs: 120_000
    })
    await expect(
      store.prepareCellDrainRecovery({
        attemptId,
        cellId: source.id,
        cellIncarnation: sourceIncarnation
      })
    ).resolves.toMatchObject({
      shouldSend: false,
      preparedAttempt: { attemptId, state: 'prepared' }
    })

    await expect(
      store.beginCellDrainSend({
        attemptId,
        cellId: source.id,
        cellIncarnation: sourceIncarnation
      })
    ).resolves.toMatchObject({ state: 'send-may-have-started', shouldSend: true })
    await expect(
      store.beginCellDrainSend({
        attemptId,
        cellId: source.id,
        cellIncarnation: sourceIncarnation
      })
    ).resolves.toMatchObject({ state: 'send-may-have-started', shouldSend: false })
    await expect(
      store.prepareCellDrainRecovery({
        attemptId,
        cellId: source.id,
        cellIncarnation: sourceIncarnation
      })
    ).rejects.toThrow('drain_application_receipt_missing')
    await expect(
      database.query(`SELECT drain_attempt_id FROM relay_post_drain_migration_pins`)
    ).resolves.toEqual([{ drain_attempt_id: attemptId }])
  })

  it('restores an expired registered migration lease with PostgreSQL locks', async () => {
    let now = 1_700_000_000_000
    const startedAt = now - 1
    const store = new RelayAssignmentStore(database, () => now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    await store.reconcileCells([source, target])
    await store.recordCellHeartbeat({
      cellId: source.id,
      cellUrl: source.url,
      cellIncarnation: sourceIncarnation,
      startedAt,
      ready: true,
      observedRequests: 0
    })
    await store.recordCellHeartbeat({
      cellId: target.id,
      cellUrl: target.url,
      cellIncarnation: targetIncarnation,
      startedAt,
      ready: true,
      observedRequests: 0
    })
    await store.assign(identity)
    await store.setCellEnabled(source.id, false)
    const migration = await store.startEvacuation(identity, target.id)
    await store.markMigrationTargetRegistered(identity, {
      cellId: target.id,
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.prepareCellDrainAttempt({
      attemptId,
      cellId: source.id,
      cellIncarnation: sourceIncarnation,
      traceValue: '44444444-4444-4444-8444-444444444444',
      plannedGraceMs: 120_000
    })

    now = migration.expiresAt + 1
    expect(await store.releaseExpiredActivityLeases()).toBeGreaterThan(0)
    await store.recordCellHeartbeat({
      cellId: source.id,
      cellUrl: source.url,
      cellIncarnation: sourceIncarnation,
      startedAt,
      ready: true,
      observedRequests: 0
    })
    await store.recordCellHeartbeat({
      cellId: target.id,
      cellUrl: target.url,
      cellIncarnation: targetIncarnation,
      startedAt,
      ready: true,
      observedRequests: 0
    })
    await expect(
      store.beginCellDrainSend({
        attemptId,
        cellId: source.id,
        cellIncarnation: sourceIncarnation
      })
    ).resolves.toMatchObject({ state: 'send-may-have-started', shouldSend: true })
    await expect(
      database.query(
        `SELECT activity_kind, cell_id FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).resolves.toContainEqual({ activity_kind: 'migration', cell_id: target.id })
  })
})
