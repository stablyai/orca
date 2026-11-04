import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment/assignment-store.js'
import { RelayCellAdmissionSelector } from './cell-admission-selector.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'
import { EDGE_CELL_ID, EdgeAssignments, EdgeMoveBusyError } from './edge-relay.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const cell = { id: 'edge-pg-c1', url: 'https://edge-pg-c1.example.com', capacityRequests: 200 }
const edgeConfig = {
  cellUrl: 'https://edge-pg.relay.example.com',
  rolloutPercent: 100,
  allowHosts: new Set<string>(),
  denyHosts: new Set<string>(),
  regions: new Set(['us-central1'] as const)
}
const hosts = ['edgepghost000001', 'edgepghost000002'].map((relayHostId) => ({
  userId: 'edge-pg-user',
  relayHostId
}))

describePostgres('relay edge on PostgreSQL', () => {
  let database: RelayDatabase
  let second: RelayDatabase

  async function removeRows(): Promise<void> {
    await database.query(`DELETE FROM relay_assignment_activity_leases WHERE user_id = ?`, ['edge-pg-user'])
    await database.query(`DELETE FROM relay_assignments WHERE user_id = ?`, ['edge-pg-user'])
    // Leave the shared selector as other files expect it: without this file's cells.
    await database.transaction(async (transaction) => {
      const selector = (
        await transaction.queryLocked(`SELECT * FROM relay_admission_selectors WHERE selector_id = 'general'`)
      )[0]
      if (selector) {
        const membership = JSON.parse(String(selector['membership_json'])) as Record<string, string[]>
        for (const key of Object.keys(membership)) {
          membership[key] = membership[key]!.filter((id) => id !== EDGE_CELL_ID && id !== cell.id)
        }
        await transaction.query(
          `UPDATE relay_admission_selectors SET membership_json = ? WHERE selector_id = 'general'`,
          [JSON.stringify(membership)]
        )
      }
      for (const table of ['relay_cell_admission', 'relay_cell_regions', 'relay_cell_runtime', 'relay_cell_connection_limits']) {
        await transaction.query(`DELETE FROM ${table} WHERE cell_id IN (?, ?)`, [EDGE_CELL_ID, cell.id]).catch(() => [])
      }
      await transaction.query(`DELETE FROM relay_cells WHERE cell_id IN (?, ?)`, [EDGE_CELL_ID, cell.id])
    })
  }

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '' })
    second = await openRelayDatabase({ databaseUrl, dataDir: '' })
    await removeRows()
  })

  afterAll(async () => {
    await removeRows()
    await database.close()
    await second.close()
  })

  it('seeds the edge cell, moves hosts with strictly newer epochs, and cells resolve them to the edge', async () => {
    const director = new RelayAssignmentStore(database, Date.now, { requireLiveCells: true, heartbeatTtlMs: 45_000 })
    await director.reconcileCellsAtStartup([cell])
    await director.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: '22222222-2222-4222-8222-222222222222',
      startedAt: Date.now() - 1_000,
      ready: true,
      observedRequests: 0
    })
    const edge = new EdgeAssignments(database, edgeConfig)
    await Promise.all([edge.ensureEdgeCell(), new EdgeAssignments(second, edgeConfig).ensureEdgeCell()])
    const inspected = await new RelayCellAdmissionSelector(database, Date.now).inspect()
    expect(inspected.selector.membership.existingOnly).toContain(EDGE_CELL_ID)

    const placed = await director.assign(hosts[0]!)
    await expect(edge.moveToEdge(hosts[0]!, 0)).rejects.toBeInstanceOf(EdgeMoveBusyError)
    await database.query(
      `UPDATE relay_assignments SET reserved_controls = 0 WHERE user_id = ? AND relay_host_id = ?`,
      [hosts[0]!.userId, hosts[0]!.relayHostId]
    )
    const moved = await edge.moveToEdge(hosts[0]!, 0)
    expect(moved.assignmentEpoch).toBe(placed.assignmentEpoch + 1)

    // Concurrent asks for one fresh host: one mints, the other keeps the same epoch or is told busy.
    const results = await Promise.allSettled([
      edge.moveToEdge(hosts[1]!, 3),
      new EdgeAssignments(second, edgeConfig).moveToEdge(hosts[1]!, 3)
    ])
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(EdgeMoveBusyError)
    }
    const fulfilled = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    expect(fulfilled.length).toBeGreaterThan(0)
    for (const value of fulfilled) expect(value.assignmentEpoch).toBe(4)

    const cellView = new RelayAssignmentStore(database, Date.now, { requireLiveCells: false })
    expect((await cellView.resolve(hosts[0]!))?.cellId).toBe(EDGE_CELL_ID)
    expect(await director.resolve(hosts[0]!)).toBeNull()
    expect((await edge.edgeAssignment(hosts[0]!))?.cellUrl).toBe(edgeConfig.cellUrl)
    expect((await director.seatFeedCells()).some((seatCell) => seatCell.cellId === EDGE_CELL_ID)).toBe(false)

    // Rollback: with the cohort off, today's placement takes the host back above the edge epoch.
    const back = await director.assign(hosts[0]!)
    expect(back.cellId).toBe(cell.id)
    expect(back.assignmentEpoch).toBeGreaterThan(moved.assignmentEpoch)
  })
})
