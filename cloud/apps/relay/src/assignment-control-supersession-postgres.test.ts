import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const cell = {
  id: 'control-supersession-postgres',
  url: 'https://control-supersession-postgres.example.com',
  capacityRequests: 1_000,
  connectionHardCap: 600 as const,
  connectionUnobservedBound: 50
}
const identity = {
  userId: 'control-supersession-postgres-user',
  relayHostId: 'supersedehost001'
}

describePostgres('PostgreSQL control supersession', () => {
  const databases: RelayDatabase[] = []

  beforeAll(async () => {
    databases.push(
      await openRelayDatabase({ databaseUrl, dataDir: '' }),
      await openRelayDatabase({ databaseUrl, dataDir: '' })
    )
  })

  afterAll(async () => {
    const database = databases[0]
    if (database) {
      await database.query(
        `DELETE FROM relay_control_connection_reservations WHERE user_id = ?`,
        [identity.userId]
      )
      await database.query(
        `DELETE FROM relay_assignment_activity_leases WHERE user_id = ?`,
        [identity.userId]
      )
      await database.query(`DELETE FROM relay_assignments WHERE user_id = ?`, [identity.userId])
      await database.query(`DELETE FROM relay_cell_connection_runtime WHERE cell_id = ?`, [cell.id])
      await database.query(`DELETE FROM relay_cell_connection_limits WHERE cell_id = ?`, [cell.id])
      await database.query(`DELETE FROM relay_cell_runtime WHERE cell_id = ?`, [cell.id])
      await database.query(`DELETE FROM relay_cells WHERE cell_id = ?`, [cell.id])
    }
    for (const connection of databases) await connection.close()
  })

  it('serializes parallel generations into one durable control', async () => {
    const stores = databases.map((database) => new RelayAssignmentStore(database, () => 100))
    await stores[0]!.reconcileCells([cell])
    await stores[0]!.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 0,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 0,
      connectionInclusionWatermark: 1,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })
    const assignment = await stores[0]!.assign(identity)

    await Promise.all([
      stores[0]!.activateControl(identity, {
        cellId: cell.id,
        assignmentEpoch: assignment.assignmentEpoch,
        generation: 1,
        connectionInclusionWatermark: 10
      }),
      stores[1]!.activateControl(identity, {
        cellId: cell.id,
        assignmentEpoch: assignment.assignmentEpoch,
        generation: 2,
        connectionInclusionWatermark: 11
      })
    ])
    await databases[0]!.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, ?, 'control', ?, 1, 90100, 100),
              (?, ?, ?, 'control', ?, 1, 90100, 100)`,
      [
        identity.userId,
        identity.relayHostId,
        `control:${cell.id}:100`,
        cell.id,
        identity.userId,
        identity.relayHostId,
        `control:${cell.id}:101`,
        cell.id
      ]
    )
    await stores[0]!.activateControl(identity, {
      cellId: cell.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 102,
      connectionInclusionWatermark: 12
    })

    const controls = await databases[0]!.query(
      `SELECT COUNT(*) AS count FROM relay_assignment_activity_leases
       WHERE user_id = ? AND activity_kind = 'control'`,
      [identity.userId]
    )
    expect(Number(controls[0]!.count)).toBe(1)
    const assignments = await databases[0]!.query(
      `SELECT reserved_controls FROM relay_assignments WHERE user_id = ?`,
      [identity.userId]
    )
    expect(Number(assignments[0]!.reserved_controls)).toBe(1)
    const cells = await databases[0]!.query(
      `SELECT reserved_requests FROM relay_cells WHERE cell_id = ?`,
      [cell.id]
    )
    expect(Number(cells[0]!.reserved_requests)).toBe(1)
    const claims = await databases[0]!.query(
      `SELECT claim_activity_id FROM relay_control_connection_reservations
       WHERE user_id = ? AND state = 'claimed'`,
      [identity.userId]
    )
    expect(claims).toEqual([{ claim_activity_id: `control:${cell.id}:102` }])
  }, 15_000)
})
