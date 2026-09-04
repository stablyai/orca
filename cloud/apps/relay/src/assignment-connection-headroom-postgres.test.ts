import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ASSIGNMENT_CONNECTION_HEADROOM_QUERY } from './assignment-connection-headroom-query.js'
import { RelayAssignmentStore } from './assignment-store.js'
import {
  openRelayDatabase,
  type RelayDatabase
} from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const headroomIndexName = 'relay_control_connection_reservation_headroom'
const cell = {
  id: 'connection-headroom-postgres',
  url: 'https://connection-headroom-postgres.example.com',
  capacityRequests: 1_000,
  connectionHardCap: 600 as const,
  connectionUnobservedBound: 50
}

describePostgres('PostgreSQL assignment connection headroom', () => {
  const databases: RelayDatabase[] = []

  beforeAll(async () => {
    databases.push(
      await openRelayDatabase({ databaseUrl, dataDir: '' }),
      await openRelayDatabase({ databaseUrl, dataDir: '' }),
      await openRelayDatabase({ databaseUrl, dataDir: '' })
    )
  })

  afterAll(async () => {
    const database = databases[0]
    if (database) {
      await database.query(
        `DELETE FROM relay_control_connection_reservations
         WHERE user_id LIKE 'connection-headroom-postgres-%'`
      )
      await database.query(
        `DELETE FROM relay_assignment_activity_leases
         WHERE user_id LIKE 'connection-headroom-postgres-%'`
      )
      await database.query(
        `DELETE FROM relay_assignments
         WHERE user_id LIKE 'connection-headroom-postgres-%'`
      )
      await database.query(
        `DELETE FROM relay_cell_connection_runtime WHERE cell_id = ?`,
        [cell.id]
      )
      await database.query(
        `DELETE FROM relay_cell_connection_limits WHERE cell_id = ?`,
        [cell.id]
      )
      await database.query(`DELETE FROM relay_cell_runtime WHERE cell_id = ?`, [cell.id])
      await database.query(`DELETE FROM relay_cells WHERE cell_id = ?`, [cell.id])
    }
    for (const connection of databases) await connection.close()
  })

  it('commits only one parallel assignment at the admission boundary', async () => {
    const stores = databases.map(
      (database) =>
        new RelayAssignmentStore(database, () => 100, {
          requireLiveCells: true,
          heartbeatTtlMs: 45_000
        })
    )
    await databases[0]!.query(
      `DELETE FROM relay_control_connection_reservations
       WHERE user_id LIKE 'connection-headroom-postgres-%'`
    )
    await databases[0]!.query(
      `DELETE FROM relay_assignment_activity_leases
       WHERE user_id LIKE 'connection-headroom-postgres-%'`
    )
    await databases[0]!.query(
      `DELETE FROM relay_assignments
       WHERE user_id LIKE 'connection-headroom-postgres-%'`
    )
    await stores[0]!.reconcileCells([cell], false)
    await stores[0]!.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 449,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 449,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })
    for (const suffix of ['1', '2']) {
      await databases[0]!.query(
        `INSERT INTO relay_assignments
         (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
          last_activity_at, reserved_controls, reserved_splices, reserved_invites,
          pending_installs, pending_confirmations, migration_leases)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `connection-headroom-postgres-${suffix}`,
          `headroomhost000${suffix}`,
          cell.id,
          1,
          90_100,
          100,
          0,
          0,
          0,
          0,
          0,
          0
        ]
      )
    }

    const results = await Promise.allSettled([
      stores[1]!.assign({
        userId: 'connection-headroom-postgres-1',
        relayHostId: 'headroomhost0001'
      }),
      stores[2]!.assign({
        userId: 'connection-headroom-postgres-2',
        relayHostId: 'headroomhost0002'
      })
    ])
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)

    const assignments = await databases[0]!.query(
      `SELECT COALESCE(SUM(reserved_controls), 0) AS count FROM relay_assignments
       WHERE user_id LIKE 'connection-headroom-postgres-%'`
    )
    const pending = await databases[0]!.query(
      `SELECT COUNT(*) AS count FROM relay_assignment_activity_leases
       WHERE user_id LIKE 'connection-headroom-postgres-%'
         AND activity_kind = 'control'
         AND activity_id LIKE 'control-pending:%'`
    )
    const reservations = await databases[0]!.query(
      `SELECT COUNT(*) AS count FROM relay_control_connection_reservations
       WHERE user_id LIKE 'connection-headroom-postgres-%'
         AND state <> 'released'`
    )
    expect(Number(assignments[0]!.count)).toBe(1)
    expect(Number(pending[0]!.count)).toBe(1)
    expect(Number(reservations[0]!.count)).toBe(1)
  }, 15_000)

  it('uses the composite headroom index when released history dominates', async () => {
    await databases[0]!.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id,
        assignment_epoch, cell_id, state, created_at, timeout_at, updated_at)
       SELECT 'headroom-plan-' || value, 'headroom-plan-' || value,
              'connection-headroom-postgres-plan', 'plan-host-' || value,
              1, ?, 'released', 1, 2, 1
       FROM generate_series(1, 50000) AS value`,
      [cell.id]
    )
    await databases[0]!.query(`ANALYZE relay_control_connection_reservations`)

    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    let reservationIndexPlan: Record<string, unknown> | undefined
    try {
      const plan = await client.query(
        `EXPLAIN (FORMAT JSON) ${ASSIGNMENT_CONNECTION_HEADROOM_QUERY}`
      )
      reservationIndexPlan = findReservationHeadroomIndexPlan(
        plan.rows[0]?.['QUERY PLAN']
      )
    } finally {
      await client.end()
    }

    expect(reservationIndexPlan).toBeDefined()
    expect(String(reservationIndexPlan?.['Index Cond'])).toContain('cell_id')
    expect(String(reservationIndexPlan?.['Index Cond'])).toContain('state = ANY')
    expect(reservationIndexPlan?.['Filter']).toBeUndefined()
  })

  it('deduplicates expired debt after a fresh PostgreSQL snapshot', async () => {
    const now = 200
    const store = new RelayAssignmentStore(databases[0]!, () => now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    const identity = {
      userId: 'connection-headroom-postgres-debt',
      relayHostId: 'headroomdebt0001'
    }
    await databases[0]!.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id,
        assignment_epoch, cell_id, state, inclusion_watermark,
        claim_activity_id, created_at, timeout_at, claimed_at, released_at,
        updated_at)
       VALUES
         (?, ?, ?, ?, 1, ?, 'late-arrival-debt', NULL, NULL, 100, 150, NULL, NULL, 150),
         (?, ?, ?, ?, 1, ?, 'late-arrival-debt', NULL, NULL, 101, 150, NULL, NULL, 150)`,
      [
        'postgres-debt-1',
        'postgres-debt-1',
        identity.userId,
        identity.relayHostId,
        cell.id,
        'postgres-debt-2',
        'postgres-debt-2',
        identity.userId,
        identity.relayHostId,
        cell.id
      ]
    )

    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 449,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 449,
      connectionInclusionWatermark: 10,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })

    expect(
      await databases[0]!.query(
        `SELECT state
         FROM relay_control_connection_reservations
         WHERE user_id = ?
         ORDER BY created_at`,
        [identity.userId]
      )
    ).toEqual([
      { state: 'late-arrival-debt' },
      { state: 'released' }
    ])
  })

  it('releases an aborted older epoch after a fresh PostgreSQL snapshot', async () => {
    const now = 300
    const store = new RelayAssignmentStore(databases[0]!, () => now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    const identity = {
      userId: 'connection-headroom-postgres-aborted',
      relayHostId: 'headroomabort001'
    }
    await databases[0]!.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, ?, 3, ?, ?, 0, 0, 0, 0, 0, 0)`,
      [identity.userId, identity.relayHostId, cell.id, now, now]
    )
    await databases[0]!.query(
      `INSERT INTO relay_assignment_migrations
       (user_id, relay_host_id, source_cell_id, target_cell_id,
        previous_epoch, assignment_epoch, source_request_units,
        target_reserved_units, expires_at, target_registered_at,
        completed_at, aborted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 2, 0, 1, ?, ?, NULL, ?, ?, ?)`,
      [
        identity.userId,
        identity.relayHostId,
        'source',
        cell.id,
        now - 2,
        now - 3,
        now - 1,
        now - 4,
        now - 1
      ]
    )
    await databases[0]!.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id,
        assignment_epoch, cell_id, state, inclusion_watermark,
        claim_activity_id, created_at, timeout_at, claimed_at, released_at,
        updated_at)
       VALUES (?, ?, ?, ?, 2, ?, 'late-arrival-debt', NULL, NULL, ?, ?, NULL, NULL, ?)`,
      [
        'postgres-aborted-reservation',
        'postgres-aborted-reservation',
        identity.userId,
        identity.relayHostId,
        cell.id,
        now - 4,
        now - 2,
        now - 1
      ]
    )

    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 449,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 449,
      connectionInclusionWatermark: 20,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })

    expect(
      await databases[0]!.query(
        `SELECT state FROM relay_control_connection_reservations
         WHERE reservation_id = ?`,
        ['postgres-aborted-reservation']
      )
    ).toEqual([{ state: 'released' }])
  })
})

function findReservationHeadroomIndexPlan(
  value: unknown
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (!Array.isArray(value) && record['Index Name'] === headroomIndexName) return record
  for (const child of Object.values(value)) {
    const match = findReservationHeadroomIndexPlan(child)
    if (match) return match
  }
  return undefined
}
