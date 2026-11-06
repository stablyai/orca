import { createHash } from 'node:crypto'
import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { RelayAssignmentStore } from './assignment/assignment-store.js'
import {
  RelayCellAdmissionSelector,
  encodeMembership,
  type CellAdmissionMembership
} from './cell-admission-selector.js'
import type { RelayCellConfig, RelayConfig } from './config.js'
import type { CredentialReservation, RelayCredentialStore } from './credential-store.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import {
  EDGE_CELL_ID,
  EdgeAssignments,
  EdgeMoveBusyError, EdgeMoveDeferredError,
  edgeCohortBucket,
  inEdgeCohort,
  mapEpochFloor,
  type EdgeRelayConfig
} from './edge-relay.js'
import { HostSessionRegistry } from './host-session-registry.js'
import type { RelayRuntimeObserver } from './relay-observability.js'
import { ProcessQueuedByteBudget } from './splice-forwarder.js'

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
  for (const database of databases.splice(0)) await database.close()
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

describe('edge cohort', () => {
  it('lets deny beat allow, allow beat region and share, and scopes the share by region', () => {
    const host = 'abcdefghijklmnop'
    expect(inEdgeCohort(edgeConfig({ rolloutPercent: 100 }), host, 'us-central1')).toBe(true)
    expect(inEdgeCohort(edgeConfig({ rolloutPercent: 100 }), host, undefined)).toBe(true)
    expect(inEdgeCohort(edgeConfig({ rolloutPercent: 100 }), host, 'asia-east2')).toBe(false)
    expect(
      inEdgeCohort(edgeConfig({ rolloutPercent: 100, regions: new Set(['us-central1', 'asia-east2']) }), host, 'asia-east2')
    ).toBe(true)
    expect(inEdgeCohort(edgeConfig({ rolloutPercent: 0 }), host, 'us-central1')).toBe(false)
    expect(inEdgeCohort(edgeConfig({ allowHosts: new Set([host]), regions: new Set() }), host, 'asia-east2')).toBe(true)
    expect(
      inEdgeCohort(edgeConfig({ rolloutPercent: 100, allowHosts: new Set([host]), denyHosts: new Set([host]) }), host, 'us-central1')
    ).toBe(false)
  })

  it('buckets hosts stably and roughly evenly', () => {
    expect(edgeCohortBucket('abcdefghijklmnop')).toBe(edgeCohortBucket('abcdefghijklmnop'))
    const hosts = Array.from({ length: 2_000 }, (_, index) => `host${String(index).padStart(12, '0')}`)
    const inTenPercent = hosts.filter((host) => edgeCohortBucket(host) < 10).length
    expect(inTenPercent).toBeGreaterThan(140)
    expect(inTenPercent).toBeLessThan(260)
  })

  it('floors the edge epoch above every epoch the seat map knows', () => {
    const source = {
      seatsOf: () => [{ epoch: 4 }],
      recentlyLeftOf: () => [{ epoch: 9 }],
      bookingOf: () => ({ epoch: 6 })
    }
    expect(mapEpochFloor(source, IDENTITY, 0)).toBe(9)
    expect(mapEpochFloor(undefined, IDENTITY, 0)).toBe(0)
  })
})

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

  it('answers nothing before the seed lands', async () => {
    const { edge } = await setup({ requireLiveCells: true })
    expect(await edge.edgeAssignment(IDENTITY)).toBeNull()
  })
})

describe('edge move', () => {
  it('mints map floor + 1 for a host with no row and keeps the epoch on re-asks', async () => {
    const { edge, setNow } = await setup({ requireLiveCells: true })
    await edge.ensureEdgeCell()
    const first = await edge.moveToEdge(IDENTITY, 7)
    expect(first).toMatchObject({ cellId: EDGE_CELL_ID, cellUrl: EDGE_URL, assignmentEpoch: 8 })
    setNow(5_000)
    const again = await edge.moveToEdge(IDENTITY, 20)
    expect(again.assignmentEpoch).toBe(8)
    expect(again.leaseExpiresAt).toBeGreaterThan(first.leaseExpiresAt)
  })

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

  it('defers the move while the host still holds units on its old cell', async () => {
    const { database, store, edge } = await setup({ requireLiveCells: true })
    await edge.ensureEdgeCell()
    await store.assign(IDENTITY)
    await database.query(
      `UPDATE relay_assignments SET reserved_splices = 1 WHERE user_id = ? AND relay_host_id = ?`,
      [IDENTITY.userId, IDENTITY.relayHostId]
    )
    await expect(edge.moveToEdge(IDENTITY, 0)).rejects.toBeInstanceOf(EdgeMoveDeferredError)
    const [row] = await database.query(`SELECT cell_id FROM relay_assignments WHERE user_id = ?`, [IDENTITY.userId])
    expect(row).toMatchObject({ cell_id: GCE_CELL.id })
  })

  it('is invisible to the director liveness rule, so phone paths must ask the edge first', async () => {
    const { store, edge } = await setup({ requireLiveCells: true })
    await edge.ensureEdgeCell()
    const moved = await edge.moveToEdge(IDENTITY, 0)
    expect(await store.resolve(IDENTITY)).toBeNull()
    expect(await edge.edgeAssignment(IDENTITY)).toMatchObject({
      cellUrl: EDGE_URL,
      assignmentEpoch: moved.assignmentEpoch
    })
  })

  it('rolls back: with the cohort off, the host is re-placed on GCE above the edge epoch', async () => {
    const { database, store, edge } = await setup({ requireLiveCells: true })
    await edge.ensureEdgeCell()
    await store.assign(IDENTITY)
    await settle(database)
    const moved = await edge.moveToEdge(IDENTITY, 0)
    const back = await store.assign(IDENTITY)
    expect(back.cellId).toBe(GCE_CELL.id)
    expect(back.assignmentEpoch).toBeGreaterThan(moved.assignmentEpoch)
    expect(await edge.edgeAssignment(IDENTITY)).toBeNull()
  })
})

describe('old cells and phones of a host moved to the edge', () => {
  const config = {
    port: 8080,
    publicUrl: GCE_CELL.url,
    cellUrl: GCE_CELL.url,
    authIssuer: 'https://auth.example.com',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.com/jwks',
    assignmentSigningKey: new Uint8Array(32),
    role: 'cell',
    cellId: GCE_CELL.id,
    cells: [GCE_CELL],
    adminAudience: `${GCE_CELL.url}/v1/admin/drain`,
    deployServiceAccount: 'deploy@example.com',
    runtimeServiceAccount: 'runtime@example.com',
    adminJwksUrl: 'https://auth.example.com/admin-jwks',
    databasePoolMax: 10,
    publicAssignmentsEnabled: true,
    publicAssignmentConcurrency: 2,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './test-data'
  } satisfies RelayConfig

  class FakeSocket {
    readonly OPEN = 1
    readyState = 1
    readonly send = vi.fn()
    readonly close = vi.fn((_code?: number, _reason?: string) => {
      this.readyState = 3
    })
    readonly terminate = vi.fn()
    readonly once = vi.fn()
    readonly on = vi.fn()
    readonly off = vi.fn()
  }

  const observer = {
    recordAuth: vi.fn(),
    recordForwardedBytes: vi.fn(),
    recordHttp: vi.fn(),
    recordReconnect: vi.fn(),
    recordSql: vi.fn(),
    recordClientAcceptAbandoned: vi.fn(),
    recordClientAcceptCompleted: vi.fn(),
    recordControlRtt: vi.fn(),
    recordPhoneRejection: vi.fn(),
    recordPhoneAttachDeadline: vi.fn()
  } satisfies RelayRuntimeObserver

  async function cellRegistry(seed: boolean) {
    // The director moved the host; the cell reads the same database without the liveness rule.
    const director = await setup({ requireLiveCells: true })
    if (seed) await director.edge.ensureEdgeCell()
    await director.store.assign(IDENTITY)
    await settle(director.database)
    if (seed) {
      await director.edge.moveToEdge(IDENTITY, 0)
    } else {
      await director.database.query(`UPDATE relay_assignments SET cell_id = ? WHERE user_id = ?`, [
        EDGE_CELL_ID,
        IDENTITY.userId
      ])
    }
    const cellStore = new RelayAssignmentStore(director.database, director.clock, { requireLiveCells: false })
    const credentials = {
      resolveResume: vi.fn().mockResolvedValue({ userId: IDENTITY.userId }),
      resolveInviteForMove: vi.fn().mockResolvedValue(null),
      reserveCredential: vi.fn()
    }
    const registry = new HostSessionRegistry(
      config,
      vi.fn(),
      credentials as unknown as RelayCredentialStore,
      cellStore,
      new ProcessQueuedByteBudget(),
      observer,
      director.clock
    )
    return { registry, cellStore, credentials }
  }

  it('database credential path: a phone of the moved host gets WRONG_CELL and re-resolves', async () => {
    const { registry, credentials } = await cellRegistry(true)
    const phone = new FakeSocket()
    await registry.acceptClient(phone as unknown as WebSocket, IDENTITY.relayHostId, 'resume-token', undefined)
    expect(phone.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.WRONG_CELL, expect.any(String))
    expect(credentials.reserveCredential).not.toHaveBeenCalled()
  })

  it('memory path: a missed seat whose row names the edge is WRONG_CELL, not HOST_OFFLINE', async () => {
    const { registry } = await cellRegistry(true)
    const phone = new FakeSocket()
    const reservation = { userId: IDENTITY.userId, relayHostId: IDENTITY.relayHostId } as CredentialReservation
    await (
      registry as unknown as {
        rejectMissedSeat: (socket: WebSocket, reservation: CredentialReservation, sessionKey: string) => Promise<void>
      }
    ).rejectMissedSeat(phone as unknown as WebSocket, reservation, `${IDENTITY.userId}\u0000${IDENTITY.relayHostId}`)
    expect(phone.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.WRONG_CELL, expect.any(String))
  })

  it('without the seeded edge cell row the memory path would pin phones with HOST_OFFLINE', async () => {
    const { registry, cellStore } = await cellRegistry(false)
    expect(await cellStore.resolve(IDENTITY)).toBeNull()
    const phone = new FakeSocket()
    const reservation = { userId: IDENTITY.userId, relayHostId: IDENTITY.relayHostId } as CredentialReservation
    await (
      registry as unknown as {
        rejectMissedSeat: (socket: WebSocket, reservation: CredentialReservation, sessionKey: string) => Promise<void>
      }
    ).rejectMissedSeat(phone as unknown as WebSocket, reservation, `${IDENTITY.userId}\u0000${IDENTITY.relayHostId}`)
    expect(phone.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.HOST_OFFLINE, expect.anything())
  })
})
