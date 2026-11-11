import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from './assignment/assignment-store.js'
import { RelayCellAdmissionSelector } from './cell/admission/cell-admission-selector.js'
import { openRelayDatabase, type RelayDatabase } from './database/database.js'
import {
  EDGE_CELL_ID,
  EDGE_LOCKED_CALLS_MAX,
  EdgeAssignments,
  EdgeMoveBusyError,
  EdgeMoveDeferredError
} from './edge-relay.js'
import type { EdgeAssignBody, EdgeDeviceRow } from './edge-admin-client.js'
import { EDGE_FENCE_RETRY_BASE_MS, retryPendingFences } from './edge-relay-fence.js'

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
const hosts = ['edgepghost000001', 'edgepghost000002', 'edgepghost000003'].map((relayHostId) => ({
  userId: 'edge-pg-user',
  relayHostId
}))

describePostgres('relay edge on PostgreSQL', () => {
  let database: RelayDatabase
  let second: RelayDatabase

  async function removeRows(): Promise<void> {
    await database.query(`DELETE FROM relay_assignment_activity_leases WHERE user_id = ?`, ['edge-pg-user'])
    await database.query(`DELETE FROM relay_assignments WHERE user_id = ?`, ['edge-pg-user'])
    await database.query(`DELETE FROM relay_devices WHERE user_id = ?`, ['edge-pg-user'])
    await database.query(`DELETE FROM relay_edge_fence_pending WHERE user_id = ?`, ['edge-pg-user'])
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
    await expect(edge.moveToEdge(hosts[0]!, 0)).rejects.toBeInstanceOf(EdgeMoveDeferredError)
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
      if (result.status === 'rejected') { expect(result.reason).toBeInstanceOf(EdgeMoveBusyError) }
    }
    const fulfilled = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    expect(fulfilled.length).toBeGreaterThan(0)
    for (const value of fulfilled) { expect(value.assignmentEpoch).toBe(4) }

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

  it('phase 2: pushes Postgres devices as numbers and writes the exported set back', async () => {
    const host = hosts[2]!
    const row = (id: string, revokedAt: number | null): EdgeDeviceRow => ({
      user_id: host.userId,
      relay_host_id: host.relayHostId,
      relay_device_id: id,
      current_hash: `hash-${id}`,
      current_version: 2,
      current_expires_at: 1_900_000_000_000,
      grace_hash: null,
      grace_version: null,
      grace_expires_at: null,
      revoked_at: revokedAt,
      updated_at: 1_800_000_000_000
    })
    await database.query(
      `INSERT INTO relay_devices (user_id, relay_host_id, relay_device_id, current_hash, current_version,
         current_expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [host.userId, host.relayHostId, 'phone-a', 'hash-phone-a', 2, 1_900_000_000_000, 1_800_000_000_000]
    )
    const pushed: unknown[] = []
    let held: EdgeDeviceRow[] = []
    const admin = {
      assign: async (body: EdgeAssignBody) => {
        pushed.push(body)
        if (body.devices) { held = body.devices }
        return { outcome: 'applied' as const, assignmentEpoch: body.assignmentEpoch }
      },
      exportHost: async () => ({
        outcome: 'exported' as const,
        assignment: { userId: host.userId, cellId: EDGE_CELL_ID, assignmentEpoch: 1 },
        devices: held
      }),
      drain: async () => ({ outcome: 'idle' as const })
    }
    const edge = new EdgeAssignments(database, edgeConfig, Date.now, admin)
    await edge.ensureEdgeCell()
    await edge.moveToEdge(host, 0)
    expect(held).toEqual([row('phone-a', null)])
    held = [row('phone-a', 1_850_000_000_000), row('phone-c', null)]
    expect(await edge.leaveEdge(host)).toBe(true)
    const back = await database.query(
      `SELECT relay_device_id, revoked_at, current_version FROM relay_devices WHERE relay_host_id = ? ORDER BY relay_device_id`,
      [host.relayHostId]
    )
    expect(back.map((r) => [r.relay_device_id, r.revoked_at === null ? null : Number(r.revoked_at), Number(r.current_version)])).toEqual([
      ['phone-a', 1_850_000_000_000, 2],
      ['phone-c', null, 2]
    ])
  })

  it('defers a move past the cap of pushes in flight under row locks, without waiting', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let calls = 0
    const admin = {
      assign: async (body: EdgeAssignBody) => {
        calls += 1
        await gate
        return { outcome: 'applied' as const, assignmentEpoch: body.assignmentEpoch }
      },
      exportHost: async () => ({ outcome: 'busy' as const }),
      drain: async () => ({ outcome: 'idle' as const })
    }
    const edge = new EdgeAssignments(database, edgeConfig, Date.now, admin)
    await edge.ensureEdgeCell()
    const capHosts = Array.from({ length: EDGE_LOCKED_CALLS_MAX + 1 }, (_, index) => ({
      userId: 'edge-pg-user',
      relayHostId: `edgepgcap${String(index).padStart(6, '0')}`
    }))
    const held = capHosts.slice(0, EDGE_LOCKED_CALLS_MAX).map((host) => edge.moveToEdge(host, 0))
    await vi.waitFor(() => expect(calls).toBe(EDGE_LOCKED_CALLS_MAX))
    const last = capHosts.at(-1)!
    await expect(edge.moveToEdge(last, 0)).rejects.toThrow('relay_edge_move_deferred:edge_busy')
    // The deferred move rolled back: no row was left behind for the last host.
    expect(await database.query(`SELECT 1 FROM relay_assignments WHERE relay_host_id = ?`, [last.relayHostId])).toEqual([])
    release()
    await Promise.all(held)
    expect((await edge.moveToEdge(last, 0)).cellId).toBe(EDGE_CELL_ID)
  })

  it('records a failed fence and lets exactly one director retry it to the current row', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = { userId: 'edge-pg-user', relayHostId: 'edgepgfence00001' }
    const sent: EdgeAssignBody[] = []
    const admin = {
      assign: async (body: EdgeAssignBody) => {
        sent.push(body)
        return { outcome: sent.length === 1 ? ('stale' as const) : ('applied' as const), assignmentEpoch: 30 }
      },
      exportHost: async () => ({ outcome: 'busy' as const }),
      drain: async () => ({ outcome: 'idle' as const })
    }
    const clock = { now: 1_700_000_000_000 }
    const edge = new EdgeAssignments(database, edgeConfig, () => clock.now, admin)
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
        reserved_controls, reserved_splices, reserved_invites, pending_installs,
        pending_confirmations, migration_leases)
       VALUES (?, ?, ?, 31, 0, 0, 0, 0, 0, 0, 0, 0)`,
      [host.userId, host.relayHostId, cell.id]
    )
    expect(await edge.fenceAway(host, cell.id, 29)).toBe(false)
    clock.now += EDGE_FENCE_RETRY_BASE_MS
    const results = await Promise.all([
      retryPendingFences(database, admin, EDGE_CELL_ID, () => clock.now),
      retryPendingFences(second, admin, EDGE_CELL_ID, () => clock.now)
    ])
    // The winner saw nothing left; the loser may still have seen the claimed record.
    expect(results).toContain(false)
    expect(sent.slice(1)).toEqual([{ ...host, cellId: cell.id, assignmentEpoch: 31 }])
    expect(await database.query(`SELECT 1 FROM relay_edge_fence_pending WHERE user_id = ?`, [host.userId])).toEqual([])
    vi.restoreAllMocks()
  })
})
