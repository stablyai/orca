// The edge-move-dormant suites' harness: a real store and EdgeAssignments on an in-memory
// database, a fake edge admin and seat map, and the director app. createRelayApp is passed in so
// it is the one each suite imports after registering its own vi.mock blocks.
import { expect, vi, type Mock } from 'vitest'
import type { createRelayApp as CreateRelayAppFn } from '../app.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from '../database.js'
import type { EdgeAdmin, EdgeAssignBody } from '../edge-admin-client.js'
import type { EdgeControlFlags } from '../edge-relay-control.js'
import { EDGE_CELL_ID, EDGE_MOVE_BUSY_RETRY_AFTER_SECONDS, EdgeAssignments } from '../edge-relay.js'
import { RelayAssignmentStore } from '../assignment/assignment-store.js'
import type { ShadowSeatDirectory } from '../shadow-seat-directory.js'
import type { IpCountryLookup } from '../ip-country.js'
import {
  EDGE_URL, HOST, INCARNATION, OTHER, RETIRING, SECOND_HOST, T0, TTL, USER,
  config, leaseLocksBusy, overlapping, type ShadowStub
} from './edge-dormant-move-fixtures.js'

type CreateRelayApp = typeof CreateRelayAppFn

const databases: RelayDatabase[] = []

// Each suite's afterEach: restores spies and closes every database a harness opened.
export async function closeHarnesses(): Promise<void> {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) { await database.close() }
}

export type HarnessOptions = {
  reserve?: boolean
  shadow?: boolean
  control?: () => EdgeControlFlags
  seeded?: boolean
  configured?: boolean
  hang?: boolean
  lockedCallsMax?: number
  allowHosts?: string[]
  denyHosts?: string[]
  rolloutPercent?: number
  // A real seat directory instead of the stub.
  directory?: ShadowSeatDirectory
  onPush?: () => void
  ipCountry?: IpCountryLookup
  // The lease rows are locked by another transaction (queryLocked answers unavailable).
  leaseLockBusy?: boolean
  // The admit-mode table cannot be read, so the reserve-mode set is unknown.
  admitModesUnreadable?: boolean
}

export async function harness(createRelayApp: CreateRelayApp, options: HarnessOptions = {}) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  const clock = { now: T0 }
  // Live cells as production directors require, so the host's next ask can be placed on one.
  const store = new RelayAssignmentStore(database, () => clock.now, { requireLiveCells: true, heartbeatTtlMs: 45_000 })
  await store.reconcileCells([RETIRING, OTHER], true)
  if (options.reserve) { await store.setCellAdmitMode(RETIRING.id, 'reserve') }
  // The source cell's current process, which the seat feed must be from.
  await store.recordCellHeartbeat({
    cellId: RETIRING.id,
    cellUrl: RETIRING.url,
    cellIncarnation: INCARNATION,
    startedAt: T0 - 1_000,
    ready: true,
    observedRequests: 0
  })
  const pushes: EdgeAssignBody[] = []
  const exports: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const admin = {
    assign: async (body: EdgeAssignBody) => {
      pushes.push(body)
      options.onPush?.()
      if (options.hang) { await gate }
      return { outcome: 'applied' as const, assignmentEpoch: body.assignmentEpoch }
    },
    // An offline desktop: the edge gives its data back at once (never 'busy').
    exportHost: async (relayHostId: string) => {
      exports.push(relayHostId)
      const assignment = { userId: USER, cellId: EDGE_CELL_ID, assignmentEpoch: 0 }
      return { outcome: 'exported' as const, assignment, devices: [] }
    }
  } as unknown as EdgeAdmin
  const edge = new EdgeAssignments(
    options.leaseLockBusy ? leaseLocksBusy(database) : options.hang ? overlapping(database) : database,
    {
      cellUrl: EDGE_URL,
      rolloutPercent: options.rolloutPercent ?? 0,
      allowHosts: new Set(options.allowHosts ?? [HOST, SECOND_HOST]),
      denyHosts: new Set(options.denyHosts ?? []),
      regions: new Set(['us-central1']),
      ...(options.control ? { control: options.control } : {}),
      ...(options.ipCountry ? { ipCountry: options.ipCountry } : {})
    },
    () => clock.now,
    admin,
    options.lockedCallsMax
  )
  if (options.seeded !== false) { await edge.ensureEdgeCell() }
  if (options.admitModesUnreadable) {
    await database.query('ALTER TABLE relay_cell_admit_modes RENAME TO relay_cell_admit_modes_gone')
  }
  const shadowState: ShadowStub = { complete: true, seated: new Set(), recentlyLeftAt: new Map(), feed: 'fresh' }
  let seatReads = 0
  const stub = {
    isComplete: () => shadowState.complete,
    seatsOf: (_userId: string, relayHostId: string) => {
      seatReads += 1
      shadowState.onSeatsRead?.(seatReads)
      return shadowState.seated.has(relayHostId) ? [{ cellId: RETIRING.id, epoch: 1 }] : []
    },
    recentlyLeftOf: (_userId: string, relayHostId: string) => {
      const at = shadowState.recentlyLeftAt.get(relayHostId)
      return at === undefined ? [] : [{ cellId: RETIRING.id, epoch: 1, at }]
    },
    bookingOf: () => shadowState.booking,
    cellState: (cellId: string) => {
      if (cellId !== RETIRING.id) { return undefined }
      const now = Date.now()
      switch (shadowState.feed) {
        case 'pending': { return { cellId, status: 'pending' } }
        // Live, but its last answered poll left before the request did.
        case 'stale': {
          return { cellId, status: 'live', incarnation: INCARNATION, polledAt: now - 60_000, caughtUpPolledAt: now - 60_000 }
        }
        case 'mismatch': {
          return { cellId, status: 'live', incarnation: 'another-process', polledAt: now, caughtUpPolledAt: now }
        }
        // Everything else fresh, but the last poll failed.
        case 'unverifiable': {
          return { cellId, status: 'unverifiable', incarnation: INCARNATION, polledAt: now, caughtUpPolledAt: now }
        }
        // A page answered now, but with more pages pending: not caught up since before the request.
        case 'partial': {
          return { cellId, status: 'live', incarnation: INCARNATION, polledAt: now, caughtUpPolledAt: now - 60_000 }
        }
        default: { return { cellId, status: 'live', incarnation: INCARNATION, polledAt: now, caughtUpPolledAt: now } }
      }
    }
  }
  const shadow = options.directory ?? stub
  const raiseEpochFloor: Mock<(identity: { userId: string; relayHostId: string }, epoch: number) => void> = vi.fn()
  const app = createRelayApp(config(), {
    store: {} as never,
    assignments: store,
    ...(options.configured === false ? {} : { edgeAssignments: edge }),
    ...(options.shadow === false ? {} : { shadowSeats: shadow as never }),
    reservePlacement: { plan: async () => ({ kind: 'database' }), raiseEpochFloor, rowEpochFloor: () => 0 } as never,
    edgeDormantFeedWaitMs: 300,
    drain: vi.fn(),
    ready: vi.fn(async () => true)
  })
  // A row dormant since `lastActivityAt` (default: exactly one TTL before the move's clock).
  const placeRow = async (
    relayHostId = HOST,
    fields: { cellId?: string; lastActivityAt?: number; invites?: number; epoch?: number } = {}
  ) =>
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
        reserved_controls, reserved_splices, reserved_invites, pending_installs,
        pending_confirmations, migration_leases)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 0, 0)`,
      [
        USER,
        relayHostId,
        fields.cellId ?? RETIRING.id,
        fields.epoch ?? 4,
        T0 - TTL,
        fields.lastActivityAt ?? T0 - TTL,
        fields.invites ?? 0
      ]
    )
  const addLease = async (expiresAt: number, relayHostId = HOST) =>
    await database.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id, request_units, expires_at, updated_at)
       VALUES (?, ?, 'invite:c7:1', 'invite', ?, 1, ?, 0)`,
      [USER, relayHostId, RETIRING.id, expiresAt]
    )
  const row = async (relayHostId = HOST) =>
    (await database.query(
      `SELECT cell_id, assignment_epoch, reserved_invites, last_activity_at FROM relay_assignments
       WHERE user_id = ? AND relay_host_id = ?`,
      [USER, relayHostId]
    ))[0]
  const move = async (body: Record<string, unknown> = {}, token = 'deploy-token') =>
    await app.request('/v1/admin/edge-move-dormant', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, userId: USER, relayHostId: HOST, sourceCellId: RETIRING.id, ...body })
    })
  // The host's own next ask, from `forwardedFor`.
  const ask = async (relayHostId: string, forwardedFor: string) =>
    await app.request('/v1/assign', {
      method: 'POST',
      headers: { authorization: `Bearer host:${relayHostId}`, 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
      body: JSON.stringify({ v: 1, relayHostId, preferredRegion: 'us-central1', reconnect: true })
    })
  const list = async (body: Record<string, unknown>) =>
    await app.request('/v1/admin/dormant-assignments', {
      method: 'POST',
      headers: { authorization: 'Bearer deploy-token', 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, ...body })
    })
  const lines = () =>
    warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('{'))
  const logged = (event: string) =>
    lines()
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.event === event)
  return {
    database, store, edge, clock, pushes, exports, release, shadowState, raiseEpochFloor,
    placeRow, addLease, row, move, ask, list, lines, logged
  }
}

export type Harness = Awaited<ReturnType<typeof harness>>

export async function expectRefused(h: Harness, response: Response, reason: string) {
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'dormant_edge_move_refused', reason })
  expect(h.logged('orca_relay_edge_dormant_move').at(-1)).toMatchObject({ outcome: 'refused', reason })
  expect(h.pushes).toHaveLength(0)
}

// Retryable: nothing moved, nothing pushed, Retry-After as relay_edge_move_busy.
export async function expectBusy(h: Harness, response: Response, reason: string) {
  expect(response.status).toBe(503)
  expect(response.headers.get('Retry-After')).toBe(String(EDGE_MOVE_BUSY_RETRY_AFTER_SECONDS))
  expect(await response.json()).toEqual({ error: 'relay_edge_move_busy', reason })
  expect(h.logged('orca_relay_edge_dormant_move').at(-1)).toMatchObject({ outcome: 'busy', reason })
  expect(h.pushes).toHaveLength(0)
  const row = await h.row()
  if (row) { expect(row.cell_id).not.toBe(EDGE_CELL_ID) }
}

// No log line ever names the host or its account.
export function expectNoIdentityLogged(h: Harness) {
  for (const line of h.lines()) {
    expect(line).not.toContain(USER)
    expect(line).not.toContain(HOST)
    expect(line).not.toContain(SECOND_HOST)
  }
}
