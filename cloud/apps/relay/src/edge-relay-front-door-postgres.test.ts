import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openRelayDatabase, type RelayDatabase } from './database.js'
import type { EdgeAdmin, EdgeAssignBody } from './edge-admin-client.js'
import { EDGE_CELL_ID, EdgeAssignments } from './edge-relay.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const DOOR = 'https://cn-pg.relay.example.com'
const EDGE_URL = 'https://edge-pg-door.relay.example.com'
const identity = { userId: 'edge-door-pg-user', relayHostId: 'edgedoorpghost01' }

describePostgres('relay edge front door on PostgreSQL', () => {
  let database: RelayDatabase

  async function removeRows(): Promise<void> {
    await database.query(`DELETE FROM relay_assignments WHERE user_id = ?`, [identity.userId])
    await database.query(`DELETE FROM relay_edge_host_regions WHERE user_id = ?`, [identity.userId])
  }

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '' })
    await removeRows()
  })

  afterAll(async () => {
    await removeRows()
    await database.close()
  })

  it('records the front door, answers phones with it, and switches back at a newer epoch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pushes: EdgeAssignBody[] = []
    const admin = {
      assign: async (body: EdgeAssignBody) => {
        pushes.push(body)
        return { outcome: 'applied' as const, assignmentEpoch: body.assignmentEpoch }
      }
    } as unknown as EdgeAdmin
    const edge = new EdgeAssignments(
      database,
      {
        cellUrl: EDGE_URL,
        frontDoorUrls: new Set([DOOR]),
        rolloutPercent: 100,
        allowHosts: new Set(),
        denyHosts: new Set(),
        regions: new Set(['us-central1'])
      },
      Date.now,
      admin
    )
    // The edge cell row is not needed for these paths; mark the director ready without seeding it.
    ;(edge as unknown as { seeded: boolean }).seeded = true
    expect(await edge.moveToEdge(identity, 0, 'us-central1', { frontDoor: DOOR, reconnect: false })).toMatchObject({
      cellId: EDGE_CELL_ID,
      cellUrl: DOOR,
      assignmentEpoch: 1
    })
    expect(await edge.edgeAssignment(identity)).toMatchObject({ cellUrl: DOOR, assignmentEpoch: 1 })
    expect(await edge.moveToEdge(identity, 0, 'us-central1', { reconnect: true })).toMatchObject({
      cellUrl: EDGE_URL,
      assignmentEpoch: 2
    })
    expect('devices' in pushes[1]!).toBe(false)
    expect(await edge.edgeAssignment(identity)).toMatchObject({ cellUrl: EDGE_URL, assignmentEpoch: 2 })
    vi.restoreAllMocks()
  })
})
