import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const schema = 'relay_deployment_status_test'
const cell = {
  id: 'deployment-status-postgres',
  url: 'https://deployment-status-postgres.example.com',
  capacityRequests: 20
}

describePostgres('PostgreSQL deployment status', () => {
  let database: RelayDatabase | undefined

  beforeAll(async () => {
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await client.query(`CREATE SCHEMA ${schema}`)
    } finally {
      await client.end()
    }
    const url = new URL(databaseUrl!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    database = await openRelayDatabase({ databaseUrl: url.toString(), dataDir: '' })
  })

  afterAll(async () => {
    await database?.close()
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    } finally {
      await client.end()
    }
  })

  it('classifies pending controls and restart blockers in one PostgreSQL query', async () => {
    const store = new RelayAssignmentStore(database!, () => 100)
    await store.reconcileCells([cell])
    await store.assign({ userId: 'status-user', relayHostId: 'a1b2c3d4e5f6' })

    expect(await store.cellDeploymentStatus(cell.id)).toMatchObject({
      activityLeases: 1,
      activityRequestUnits: 1,
      reservedRequests: 1,
      restartBlockingActivityLeases: 0,
      restartBlockingActivityRequestUnits: 0,
      restartBlockingReservedRequests: 0
    })

    await database!.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES ('blocking-user', 'b1c2d3e4f5a6', 'invite:test', 'invite', ?, 1, 90100, 100),
              ('malformed-user', 'c1d2e3f4a5b6', 'control-pending:bad', 'control', ?, 2, 90100, 100)`,
      [cell.id, cell.id]
    )
    await database!.query(
      `UPDATE relay_cells SET reserved_requests = reserved_requests + 3 WHERE cell_id = ?`,
      [cell.id]
    )

    expect(await store.cellDeploymentStatus(cell.id)).toMatchObject({
      activityLeases: 3,
      activityRequestUnits: 4,
      reservedRequests: 4,
      restartBlockingActivityLeases: 2,
      restartBlockingActivityRequestUnits: 3,
      restartBlockingReservedRequests: 3
    })

    await database!.query(
      `UPDATE relay_cells SET reserved_requests = 0 WHERE cell_id = ?`,
      [cell.id]
    )
    expect(await store.cellDeploymentStatus(cell.id)).toMatchObject({
      restartBlockingReservedRequests: -1
    })
  })
})
