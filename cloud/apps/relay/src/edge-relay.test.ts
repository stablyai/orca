import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment/assignment-store.js'
import {
  RelayCellAdmissionSelector,
  encodeMembership,
  type CellAdmissionMembership
} from './cell/admission/cell-admission-selector.js'
import type { RelayCellConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database/database.js'
import { EDGE_CELL_ID, EdgeAssignments, EdgeMoveDeferredError, type EdgeRelayConfig } from './edge-relay.js'

const EDGE_URL = 'https://edge.relay.example.com'
const GCE_CELL: RelayCellConfig = { id: 'production-gce-c3', url: 'https://c3.relay.example.com', capacityRequests: 1_000 }
const IDENTITY = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }

function edgeConfig(overrides: Partial<EdgeRelayConfig> = {}): EdgeRelayConfig {
  return {
    cellUrl: EDGE_URL,
    rolloutPercent: 0,
    allowHosts: new Set(),
    denyHosts: new Set(),
    regions: new Set(['us-central1']),
    ...overrides
  }
}

const databases: RelayDatabase[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) { await database.close() }
})

async function setup(options: { requireLiveCells: boolean }) {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  let now = 1_000
  const clock = () => now
  const store = new RelayAssignmentStore(database, clock, {
    requireLiveCells: options.requireLiveCells,
    heartbeatTtlMs: 45_000
  })
  await store.reconcileCells([GCE_CELL], true)
  await store.recordCellHeartbeat({
    cellId: GCE_CELL.id,
    cellUrl: GCE_CELL.url,
    cellIncarnation: '11111111-1111-4111-8111-111111111111',
    startedAt: 500,
    ready: true,
    observedRequests: 0
  })
  const edge = new EdgeAssignments(database, edgeConfig(), clock)
  return { database, store, edge, setNow: (value: number) => (now = value), clock }
}

// The host's control on its GCE cell has come and gone: no units left on the old cell.
async function settle(database: RelayDatabase, identity = IDENTITY): Promise<void> {
  await database.query(
    `UPDATE relay_assignments SET reserved_controls = 0, reserved_splices = 0, reserved_invites = 0,
       pending_installs = 0, pending_confirmations = 0, migration_leases = 0
     WHERE user_id = ? AND relay_host_id = ?`,
    [identity.userId, identity.relayHostId]
  )
}

// What a deploy workflow sends: the fingerprint of the membership it inspected.
function fingerprint(membership: CellAdmissionMembership): string {
  return createHash('sha256').update(encodeMembership(membership)).digest('hex')
}

describe('edge cell seed', () => {
  it('registers a disabled, empty, existing-only cell the admission selector carries without drift', async () => {
    const { database, store, edge, clock } = await setup({ requireLiveCells: true })
    expect(edge.ready).toBe(false)
    await edge.ensureEdgeCell()
    await edge.ensureEdgeCell()
    expect(edge.ready).toBe(true)
    const [cell] = await database.query(`SELECT * FROM relay_cells WHERE cell_id = ?`, [EDGE_CELL_ID])
    expect(cell).toMatchObject({ cell_url: EDGE_URL, enabled: 0, capacity_requests: 0 })
    expect(await database.query(`SELECT * FROM relay_cell_runtime WHERE cell_id = ?`, [EDGE_CELL_ID])).toEqual([])
    const selector = new RelayCellAdmissionSelector(database, clock)
    const inspected = await selector.inspect()
    expect(inspected.selector.membership.existingOnly).toContain(EDGE_CELL_ID)
    // A deploy workflow carries the edge like a retired cell.
    await selector.apply({
      attemptId: 'attempt-1',
      expectedGeneration: inspected.selector.generation,
      expectedMembershipSha256: fingerprint(inspected.selector.membership),
      membership: { existingOnly: [EDGE_CELL_ID], migrationOnly: [], general: [GCE_CELL.id] }
    })
    // Restarts reconcile the configured cells without disturbing it.
    await store.reconcileCellsAtStartup([GCE_CELL])
    expect((await selector.inspect()).selector.membership.existingOnly).toEqual([EDGE_CELL_ID])
    // Not polled for a seat feed, never in the region probe list.
    expect((await store.seatFeedCells()).map((seatCell) => seatCell.cellId)).toEqual([GCE_CELL.id])
  })

  it('joins a selector that a roll already advanced, without bumping its generation', async () => {
    const { database, edge, clock } = await setup({ requireLiveCells: true })
    const selector = new RelayCellAdmissionSelector(database, clock)
    await selector.apply({
      attemptId: 'attempt-1',
      expectedGeneration: 0,
      expectedMembershipSha256: fingerprint((await selector.inspect()).selector.membership),
      membership: { existingOnly: [], migrationOnly: [], general: [GCE_CELL.id] }
    })
    await edge.ensureEdgeCell()
    const inspected = await selector.inspect()
    expect(inspected.selector.generation).toBe(1)
    expect(inspected.selector.membership).toEqual({
      existingOnly: [EDGE_CELL_ID],
      migrationOnly: [],
      general: [GCE_CELL.id]
    })
  })
})

describe('edge move', () => {

  it('moves a host off a GCE cell with a strictly newer epoch than both the row and the map', async () => {
    const { database, store, edge } = await setup({ requireLiveCells: true })
    await edge.ensureEdgeCell()
    const placed = await store.assign(IDENTITY)
    expect(placed.cellId).toBe(GCE_CELL.id)
    await expect(edge.moveToEdge(IDENTITY, 0)).rejects.toBeInstanceOf(EdgeMoveDeferredError)
    await settle(database)
    const lowFloor = await edge.moveToEdge({ ...IDENTITY, userId: 'user-2' }, 0)
    expect(lowFloor.assignmentEpoch).toBe(1)
    const moved = await edge.moveToEdge(IDENTITY, placed.assignmentEpoch + 3)
    expect(moved.assignmentEpoch).toBe(placed.assignmentEpoch + 4)
  })

})
