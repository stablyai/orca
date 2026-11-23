import { afterEach, describe, expect, it, vi } from 'vitest'
import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import type { RelayConfig, RelayCellConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import type { EdgeAdmin, EdgeAssignBody } from './edge-admin-client.js'
import type { EdgeControlFlags } from './edge-relay-control.js'
import {
  EDGE_CELL_ID,
  EDGE_MOVE_BUSY_RETRY_AFTER_SECONDS,
  EdgeAssignments,
  EdgeMoveBusyError,
  edgeCohortBucketPermille,
  inEdgeCohort,
  mayBeOnEdge,
  type EdgeRelayConfig
} from './edge-relay.js'
import { DORMANT_PAGE_SCAN_MAX, RelayAssignmentStore } from './assignment/assignment-store.js'
import { ShadowSeatDirectory } from './shadow-seat-directory.js'

vi.mock('./admin-token-verifier.js', () => ({
  createAdminTokenVerifier: () => async (token: string) => token === 'deploy-token',
  createReadOnlyAdminTokenVerifier: () => async () => false,
  createRegionalRehomeControlApplyTokenVerifier: () => async () => false,
  createRegionalRehomeRuntimeTokenVerifier: () => async () => false,
  createRegionalRehomeTokenVerifier: () => async () => false,
  createRuntimeTokenVerifier: () => async () => false
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => async () => null,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

const EDGE_URL = 'https://edge.relay.example.test'
const RETIRING: RelayCellConfig = { id: 'production-gce-c7', url: 'https://c7.relay.example.test', capacityRequests: 1_000 }
const OTHER: RelayCellConfig = { id: 'production-gce-c8', url: 'https://c8.relay.example.test', capacityRequests: 1_000 }
const USER = 'user-dormant-1'
const HOST = 'dormanthost00001'
const SECOND_HOST = 'dormanthost00002'
const IDENTITY = { userId: USER, relayHostId: HOST }
const T0 = 1_000_000_000_000
const TTL = ASSIGNMENT_LIMITS.dormantTtlMs

function config(): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://relay.example.test',
    cellUrl: 'https://relay.example.test',
    region: 'us-central1',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: new TextEncoder().encode('assignment-key-with-at-least-32-bytes'),
    role: 'director',
    cellId: 'director',
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    runtimeServiceAccount: 'runtime@example.test',
    adminJwksUrl: 'https://auth.example.test/jwks',
    databasePoolMax: 3,
    publicAssignmentsEnabled: true,
    regionalPlacementEnabled: true,
    publicAssignmentConcurrency: 2,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './data'
  }
}

// SQLite serializes transactions; run them inline so moves overlap as they do on Postgres.
function overlapping(database: RelayDatabase): RelayDatabase {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'transaction') {
        return async <T>(operation: (transaction: RelayDatabase) => Promise<T>) => await operation(target)
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

type ShadowStub = {
  complete: boolean
  seated: Set<string>
  recentlyLeftAt: Map<string, number>
  booking?: { cellId: string; epoch: number; at: number }
  // The source cell's feed: 'fresh' answers a poll sent just now, by the cell's current process.
  feed: 'fresh' | 'pending' | 'stale' | 'mismatch'
  // Called on every seatsOf read: lets a test seat the host part way through a move.
  onSeatsRead?: (reads: number) => void
}

const INCARNATION = '33333333-3333-4333-8333-333333333333'

const databases: RelayDatabase[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) { await database.close() }
})

async function harness(options: {
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
} = {}) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  const clock = { now: T0 }
  const store = new RelayAssignmentStore(database, () => clock.now)
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
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const admin = {
    assign: async (body: EdgeAssignBody) => {
      pushes.push(body)
      options.onPush?.()
      if (options.hang) { await gate }
      return { outcome: 'applied' as const, assignmentEpoch: body.assignmentEpoch }
    }
  } as unknown as EdgeAdmin
  const edge = new EdgeAssignments(
    options.hang ? overlapping(database) : database,
    {
      cellUrl: EDGE_URL,
      rolloutPercent: options.rolloutPercent ?? 0,
      allowHosts: new Set(options.allowHosts ?? [HOST, SECOND_HOST]),
      denyHosts: new Set(options.denyHosts ?? []),
      regions: new Set(['us-central1']),
      ...(options.control ? { control: options.control } : {})
    },
    () => clock.now,
    admin,
    options.lockedCallsMax
  )
  if (options.seeded !== false) { await edge.ensureEdgeCell() }
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
        case 'stale': { return { cellId, status: 'live', incarnation: INCARNATION, polledAt: now - 60_000, lastLiveAt: now - 60_000 } }
        case 'mismatch': { return { cellId, status: 'live', incarnation: 'another-process', polledAt: now, lastLiveAt: now } }
        default: { return { cellId, status: 'live', incarnation: INCARNATION, polledAt: now, lastLiveAt: now } }
      }
    }
  }
  const shadow = options.directory ?? stub
  const raiseEpochFloor = vi.fn()
  const app = createRelayApp(config(), {
    store: {} as never,
    assignments: store,
    ...(options.configured === false ? {} : { edgeAssignments: edge }),
    ...(options.shadow === false ? {} : { shadowSeats: shadow as never }),
    reservePlacement: { raiseEpochFloor, rowEpochFloor: () => 0 } as never,
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
    database, store, edge, clock, pushes, release, shadowState, raiseEpochFloor,
    placeRow, addLease, row, move, list, lines, logged
  }
}

type Harness = Awaited<ReturnType<typeof harness>>

async function expectRefused(h: Harness, response: Response, reason: string) {
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'dormant_edge_move_refused', reason })
  expect(h.logged('orca_relay_edge_dormant_move').at(-1)).toMatchObject({ outcome: 'refused', reason })
  expect(h.pushes).toHaveLength(0)
}

// No log line ever names the host or its account.
function expectNoIdentityLogged(h: Harness) {
  for (const line of h.lines()) {
    expect(line).not.toContain(USER)
    expect(line).not.toContain(HOST)
    expect(line).not.toContain(SECOND_HOST)
  }
}

describe('POST /v1/admin/edge-move-dormant', () => {
  it('moves a dormant host on a database-mode cell through the edge move path', async () => {
    const h = await harness()
    await h.placeRow()
    const response = await h.move()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ v: 1, moved: true, assignmentEpoch: 5 })
    expect(await h.row()).toMatchObject({ cell_id: EDGE_CELL_ID, assignment_epoch: 5 })
    expect(h.pushes).toEqual([expect.objectContaining({ ...IDENTITY, cellId: EDGE_CELL_ID, assignmentEpoch: 5 })])
    expect(h.raiseEpochFloor).toHaveBeenCalledWith(IDENTITY, 5)
    // The region the host is recorded for: its cell's, with no asked-for one on record.
    const region = (await h.database.query(`SELECT region FROM relay_edge_host_regions`))[0]
    expect(region).toMatchObject({ region: 'us-central1' })
    expect(h.logged('orca_relay_edge_moved')).toEqual([
      { event: 'orca_relay_edge_moved', fromCellId: RETIRING.id, assignmentEpoch: 5, dormant: true }
    ])
    expect(h.logged('orca_relay_edge_dormant_move')).toEqual([
      { event: 'orca_relay_edge_dormant_move', outcome: 'moved', admitMode: 'db' }
    ])
    expectNoIdentityLogged(h)
  })

  it('records the host\'s asked-for region and clears a front door left from an earlier stay', async () => {
    const h = await harness()
    await h.placeRow()
    await h.database.query(
      `INSERT INTO relay_assignment_region_preferences (user_id, relay_host_id, preferred_region, observed_at)
       VALUES (?, ?, 'asia-east2', 0)`,
      [USER, HOST]
    )
    await h.database.query(
      `INSERT INTO relay_edge_host_regions (user_id, relay_host_id, region, recorded_at, cell_url, pending_epoch)
       VALUES (?, ?, 'us-central1', 0, 'https://door.relay.example.test', 3)`,
      [USER, HOST]
    )
    expect((await h.move()).status).toBe(200)
    expect((await h.database.query(`SELECT region, cell_url, pending_epoch FROM relay_edge_host_regions`))[0]).toEqual({
      region: 'asia-east2',
      cell_url: null,
      pending_epoch: null
    })
    // The host is listed by id (allowHosts), so the cohort takes it whatever its region.
    expect(h.pushes[0]?.locationHint).toBe('apac')
  })

  it('releases the old cell\'s connection reservations at the old epoch, as rebalance-dormant does', async () => {
    const h = await harness()
    await h.placeRow()
    await h.database.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id, assignment_epoch, cell_id, state,
        created_at, timeout_at, updated_at)
       VALUES ('reservation-1', 'idempotency-1', ?, ?, 4, ?, 'reserved', 0, 0, 0)`,
      [USER, HOST, RETIRING.id]
    )
    const reserved = `SELECT 1 FROM relay_control_connection_reservations WHERE cell_id = ? AND state <> 'released'`
    expect(await h.database.query(reserved, [RETIRING.id])).toHaveLength(1)
    expect((await h.move()).status).toBe(200)
    expect(await h.database.query(reserved, [RETIRING.id])).toHaveLength(0)
  })

  it('takes the dormant TTL boundary from rebalance-dormant: one ms short refuses, exactly the TTL moves', async () => {
    const h = await harness()
    await h.placeRow(HOST, { lastActivityAt: T0 - TTL + 1 })
    await expectRefused(h, await h.move(), 'not_dormant')
    expect((await h.row())?.cell_id).toBe(RETIRING.id)
    h.clock.now += 1
    expect((await h.move()).status).toBe(200)
    expect((await h.row())?.cell_id).toBe(EDGE_CELL_ID)
  })

  it('lists only rows past the same boundary', async () => {
    const h = await harness()
    await h.placeRow(HOST, { lastActivityAt: T0 - TTL })
    await h.placeRow(SECOND_HOST, { lastActivityAt: T0 - TTL + 1 })
    const body = (await (await h.list({ cellId: RETIRING.id })).json()) as { candidates: unknown[] }
    expect(body.candidates).toEqual([IDENTITY])
  })

  it('refuses a row found on another cell than the expected source', async () => {
    const h = await harness()
    await h.placeRow(HOST, { cellId: OTHER.id })
    await expectRefused(h, await h.move(), 'source_mismatch')
    expect((await h.row())?.cell_id).toBe(OTHER.id)
  })

  it('refuses a host with no row, and inserts none', async () => {
    const h = await harness()
    await expectRefused(h, await h.move(), 'assignment_not_found')
    expect(await h.row()).toBeUndefined()
  })

  it('refuses a host already on the edge without refreshing its row', async () => {
    const h = await harness()
    await h.placeRow()
    expect((await h.move()).status).toBe(200)
    const before = await h.row()
    h.pushes.length = 0
    h.clock.now += 1_000
    await expectRefused(h, await h.move(), 'already_on_edge')
    expect(await h.row()).toEqual(before)
  })

  it('refuses counters on a database-mode cell, where they are the truth', async () => {
    const h = await harness()
    await h.placeRow(HOST, { invites: 2 })
    await expectRefused(h, await h.move(), 'units_held')
    expect(await h.row()).toMatchObject({ cell_id: RETIRING.id, reserved_invites: 2 })
  })

  it('refuses a live lease and moves past an expired one', async () => {
    const h = await harness()
    await h.placeRow()
    await h.addLease(T0 + 1)
    await expectRefused(h, await h.move(), 'lease_live')
    await h.database.query(`UPDATE relay_assignment_activity_leases SET expires_at = ?`, [T0])
    expect((await h.move()).status).toBe(200)
  })

  it('refuses while a migration or region rehome is open', async () => {
    const h = await harness()
    await h.placeRow()
    await h.database.query(
      `INSERT INTO relay_assignment_migrations
       (user_id, relay_host_id, source_cell_id, target_cell_id, previous_epoch, assignment_epoch,
        source_request_units, target_reserved_units, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 4, 5, 0, 1, ?, 0, 0)`,
      [USER, HOST, RETIRING.id, OTHER.id, T0 + 60_000]
    )
    await expectRefused(h, await h.move(), 'migration_open')
    expect((await h.row())?.cell_id).toBe(RETIRING.id)
  })

  describe('on a reserve-mode cell', () => {
    it('moves past stale counters no live lease backs, as drain-stale does', async () => {
      const h = await harness({ reserve: true })
      await h.placeRow(HOST, { invites: 28 })
      await h.addLease(T0)
      expect((await h.move()).status).toBe(200)
      expect(await h.row()).toMatchObject({ cell_id: EDGE_CELL_ID, reserved_invites: 0 })
      expect(h.logged('orca_relay_edge_moved')).toEqual([
        expect.objectContaining({ dormant: true, staleUnits: true })
      ])
      expect(h.logged('orca_relay_edge_dormant_move')).toEqual([
        { event: 'orca_relay_edge_dormant_move', outcome: 'moved', admitMode: 'reserve' }
      ])
      expectNoIdentityLogged(h)
    })

    it('refuses stale counters a live lease backs', async () => {
      const h = await harness({ reserve: true })
      await h.placeRow(HOST, { invites: 28 })
      await h.addLease(T0 + 1)
      await expectRefused(h, await h.move(), 'lease_live')
    })

    it('still applies the dormant TTL to the row', async () => {
      const h = await harness({ reserve: true })
      await h.placeRow(HOST, { invites: 28, lastActivityAt: T0 - TTL + 1 })
      await expectRefused(h, await h.move(), 'not_dormant')
    })

    it('refuses without a complete seat map, since the cell keeps activity in memory', async () => {
      const incomplete = await harness({ reserve: true })
      await incomplete.placeRow()
      incomplete.shadowState.complete = false
      await expectRefused(incomplete, await incomplete.move(), 'seat_map_incomplete')
      const none = await harness({ reserve: true, shadow: false })
      await none.placeRow()
      await expectRefused(none, await none.move(), 'seat_map_incomplete')
    })

    it('refuses a host the seat map shows seated, or seen within the TTL', async () => {
      const h = await harness({ reserve: true })
      await h.placeRow()
      h.shadowState.seated.add(HOST)
      await expectRefused(h, await h.move(), 'host_seated')
      h.shadowState.seated.clear()
      h.shadowState.recentlyLeftAt.set(HOST, Date.now() - 60_000)
      await expectRefused(h, await h.move(), 'host_recently_seated')
      expect((await h.row())?.cell_id).toBe(RETIRING.id)
    })

    it('lists rows with counters on a reserve-mode cell, and not on a database-mode one', async () => {
      const reserve = await harness({ reserve: true })
      await reserve.placeRow(HOST, { invites: 3 })
      expect(await (await reserve.list({ cellId: RETIRING.id })).json()).toEqual({
        v: 1, admitMode: 'reserve', candidates: [IDENTITY], cursor: null
      })
      const db = await harness()
      await db.placeRow(HOST, { invites: 3 })
      expect(await (await db.list({ cellId: RETIRING.id })).json()).toEqual({
        v: 1, admitMode: 'db', candidates: [], cursor: null
      })
    })
  })

  it('refuses before any row read when the edge is not configured, ready or on, or the host is not the cohort\'s', async () => {
    const cases: Array<[Parameters<typeof harness>[0], string]> = [
      [{ configured: false }, 'edge_not_configured'],
      [{ seeded: false }, 'edge_not_ready'],
      [{ control: () => ({ mode: 'off' }) }, 'edge_mode_not_on'],
      [{ control: () => ({ mode: 'down' }) }, 'edge_mode_not_on'],
      [{ denyHosts: [HOST] }, 'host_denied'],
      [{ allowHosts: [] }, 'not_in_cohort']
    ]
    for (const [options, reason] of cases) {
      const h = await harness(options)
      await h.placeRow()
      await expectRefused(h, await h.move(), reason)
      expect((await h.row())?.cell_id).toBe(RETIRING.id)
    }
  })

  it('answers 503 with Retry-After when the director\'s locked pushes are at the cap, never waiting', async () => {
    const h = await harness({ hang: true, lockedCallsMax: 1 })
    await h.placeRow(HOST)
    await h.placeRow(SECOND_HOST)
    const held = h.move()
    await vi.waitFor(() => expect(h.pushes).toHaveLength(1))
    const busy = await h.move({ relayHostId: SECOND_HOST })
    expect(busy.status).toBe(503)
    expect(busy.headers.get('Retry-After')).toBe(String(EDGE_MOVE_BUSY_RETRY_AFTER_SECONDS))
    expect(await busy.json()).toEqual({ error: 'relay_edge_move_busy', reason: 'edge_busy' })
    expect(h.logged('orca_relay_edge_dormant_move').at(-1)).toMatchObject({ outcome: 'busy', reason: 'edge_busy' })
    // Nothing was sent for the busy host. (Its row write rolls back with the transaction on a real
    // database; the inline transactions here cannot roll back, so the row is not checked.)
    expect(h.pushes).toHaveLength(1)
    h.release()
    expect((await held).status).toBe(200)
    expectNoIdentityLogged(h)
  })

  it('answers 503 with Retry-After when another director holds the row', async () => {
    const h = await harness()
    await h.placeRow()
    vi.spyOn(h.edge, 'moveDormantToEdge').mockRejectedValue(new EdgeMoveBusyError())
    const response = await h.move()
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe(String(EDGE_MOVE_BUSY_RETRY_AFTER_SECONDS))
    expect(await response.json()).toEqual({ error: 'relay_edge_move_busy', reason: 'relay_edge_move_busy' })
  })

  it('keeps rebalance-dormant\'s admin token, size and strict schema rules', async () => {
    const h = await harness()
    expect((await h.move({}, 'other-token')).status).toBe(401)
    expect((await h.move({ extra: true })).status).toBe(400)
    expect((await h.move({ relayHostId: 'short' })).status).toBe(400)
    expect((await h.move({ sourceCellId: EDGE_CELL_ID })).status).toBe(400)
    expect((await h.move({ userId: 'u'.repeat(300_000) })).status).toBe(413)
  })
})

describe('POST /v1/admin/dormant-assignments', () => {
  it('pages a cell in key order with an opaque cursor', async () => {
    const h = await harness()
    const hosts = ['dormantpage00001', 'dormantpage00002', 'dormantpage00003']
    for (const relayHostId of hosts) { await h.placeRow(relayHostId) }
    await h.placeRow('dormantpage00009', { cellId: OTHER.id })
    const first = (await (await h.list({ cellId: RETIRING.id, limit: 2 })).json()) as {
      candidates: Array<{ relayHostId: string }>
      cursor: string
    }
    expect(first.candidates.map((candidate) => candidate.relayHostId)).toEqual(hosts.slice(0, 2))
    expect(first.cursor).toEqual(expect.any(String))
    const second = (await (await h.list({ cellId: RETIRING.id, limit: 2, cursor: first.cursor })).json()) as {
      candidates: Array<{ relayHostId: string }>
      cursor: string | null
    }
    expect(second.candidates.map((candidate) => candidate.relayHostId)).toEqual(hosts.slice(2))
    expect(second.cursor).toBeNull()
  })

  it('bounds the page and refuses a cursor it did not make', async () => {
    const h = await harness()
    expect((await h.list({ cellId: RETIRING.id, limit: 101 })).status).toBe(400)
    expect((await h.list({ cellId: RETIRING.id, cursor: 'not-a-cursor' })).status).toBe(400)
    expect((await h.list({ cellId: EDGE_CELL_ID })).status).toBe(400)
  })
})

describe('the dormant move on a reserve-mode cell trusts only a fresh feed from the cell\'s process', () => {
  // The source is roll-isolated in these tests (not required for completeness), as a cell being
  // retired is: the map reads complete without the source ever having answered.
  function directory(): ShadowSeatDirectory {
    const map = new ShadowSeatDirectory()
    map.setCells([RETIRING.id, OTHER.id], [OTHER.id])
    map.apply(OTHER.id, { v: 1, cellId: OTHER.id, incarnation: 'other-cell', seq: 0, at: 0, full: [] }, Date.now())
    return map
  }
  function answer(
    map: ShadowSeatDirectory,
    polledAt: number,
    incarnation = INCARNATION,
    full: Array<{ userId: string; relayHostId: string; epoch: number; generation: number; state: string; joinedAt: number }> = []
  ) {
    map.apply(RETIRING.id, { v: 1, cellId: RETIRING.id, incarnation, seq: 0, at: polledAt, full }, polledAt, polledAt)
  }
  async function expectFeedNotFresh(h: Harness, response: Response) {
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe(String(EDGE_MOVE_BUSY_RETRY_AFTER_SECONDS))
    expect(await response.json()).toEqual({ error: 'relay_edge_move_busy', reason: 'feed_not_fresh' })
    expect(h.logged('orca_relay_edge_dormant_move').at(-1)).toMatchObject({ outcome: 'busy', reason: 'feed_not_fresh' })
    expect((await h.row())?.cell_id).toBe(RETIRING.id)
    expect(h.pushes).toHaveLength(0)
  }

  it('refuses, retryably, a source feed that never answered though the map reads complete', async () => {
    const map = directory()
    expect(map.isComplete()).toBe(true)
    const h = await harness({ reserve: true, directory: map })
    await h.placeRow(HOST, { invites: 2 })
    await expectFeedNotFresh(h, await h.move())
  })

  it('refuses a source feed whose last poll left before the request', async () => {
    const map = directory()
    answer(map, Date.now() - 10_000)
    const h = await harness({ reserve: true, directory: map })
    await h.placeRow()
    await expectFeedNotFresh(h, await h.move())
  })

  it('refuses a fresh feed from another process than the cell\'s runtime row', async () => {
    const map = directory()
    const h = await harness({ reserve: true, directory: map })
    await h.placeRow()
    const pending = h.move()
    setTimeout(() => answer(map, Date.now(), 'an-older-process'), 30)
    await expectFeedNotFresh(h, await pending)
  })

  it('moves once a poll sent after the request shows the host absent', async () => {
    const map = directory()
    answer(map, Date.now() - 10_000)
    const h = await harness({ reserve: true, directory: map })
    await h.placeRow(HOST, { invites: 2 })
    const pending = h.move()
    setTimeout(() => answer(map, Date.now()), 30)
    expect((await pending).status).toBe(200)
    expect((await h.row())?.cell_id).toBe(EDGE_CELL_ID)
  })

  it('refuses a host that poll shows seated', async () => {
    const map = directory()
    const h = await harness({ reserve: true, directory: map })
    await h.placeRow()
    const pending = h.move()
    setTimeout(
      () => answer(map, Date.now(), INCARNATION, [{ ...IDENTITY, epoch: 4, generation: 1, state: 'active', joinedAt: 1 }]),
      30
    )
    await expectRefused(h, await pending, 'host_seated')
  })

  it('refuses each degraded feed state of the stub too', async () => {
    for (const feed of ['pending', 'stale', 'mismatch'] as const) {
      const h = await harness({ reserve: true })
      await h.placeRow()
      h.shadowState.feed = feed
      await expectFeedNotFresh(h, await h.move())
    }
  })
})

describe('the dormant move re-reads the seat map under the row lock and after the push', () => {
  it('refuses a recent booking on any cell', async () => {
    const h = await harness({ reserve: true })
    await h.placeRow()
    h.shadowState.booking = { cellId: RETIRING.id, epoch: 9, at: Date.now() - 60_000 }
    await expectRefused(h, await h.move(), 'host_booked')
  })

  it('mints above an old booking\'s epoch (the seat map floor)', async () => {
    const h = await harness()
    await h.placeRow()
    h.shadowState.booking = { cellId: OTHER.id, epoch: 50, at: Date.now() - TTL - 60_000 }
    const response = await h.move()
    expect(await response.json()).toEqual({ v: 1, moved: true, assignmentEpoch: 51 })
    expect(h.pushes[0]?.assignmentEpoch).toBe(51)
  })

  it('refuses a seat that appears before the row lock is taken', async () => {
    const h = await harness({ reserve: true })
    await h.placeRow()
    // Read 1 is the check before the transaction; read 2 is under the row lock.
    h.shadowState.onSeatsRead = (reads) => {
      if (reads === 2) { h.shadowState.seated.add(HOST) }
    }
    await expectRefused(h, await h.move(), 'host_seated')
    expect((await h.row())?.cell_id).toBe(RETIRING.id)
  })

  it('rolls the move back when a seat appears during the push', async () => {
    let seat: () => void = () => {}
    const h = await harness({ reserve: true, onPush: () => seat() })
    seat = () => h.shadowState.seated.add(HOST)
    await h.placeRow(HOST, { invites: 3 })
    const response = await h.move()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'dormant_edge_move_refused', reason: 'host_seated' })
    // Pushed, but the row (and its counters) never committed.
    expect(h.pushes).toHaveLength(1)
    expect(await h.row()).toMatchObject({ cell_id: RETIRING.id, reserved_invites: 3, assignment_epoch: 4 })
    expect(h.logged('orca_relay_edge_moved')).toEqual([])
  })
})

describe('the dormant move judges the cohort as for an unknown country', () => {
  it('refuses a rollout host when its region excludes any country, and moves a host listed by id', async () => {
    const control = () => ({ mode: 'on' as const, regionExcludeCountries: { 'us-central1': ['CN'] } })
    const rollout = await harness({ allowHosts: [], rolloutPercent: 100, control })
    await rollout.placeRow()
    await expectRefused(rollout, await rollout.move(), 'country_unknown')
    const listed = await harness({ control })
    await listed.placeRow()
    expect((await listed.move()).status).toBe(200)
  })

  it('refuses a rollout host when its region excludes unknown countries', async () => {
    const control = () => ({ mode: 'on' as const, regionExcludeUnknownCountry: { 'us-central1': true } })
    const h = await harness({ allowHosts: [], rolloutPercent: 100, control })
    await h.placeRow()
    await expectRefused(h, await h.move(), 'not_in_cohort')
  })

  it('moves a rollout host with no exclusion', async () => {
    const h = await harness({ allowHosts: [], rolloutPercent: 100 })
    await h.placeRow()
    expect((await h.move()).status).toBe(200)
  })

  // Why the move checks inEdgeCohort only: every host it admits is within the leave ceiling, so
  // its next ask reads (and can leave) its edge row.
  it('only admits hosts mayBeOnEdge would read back', () => {
    const hosts = Array.from({ length: 400 }, (_, index) => `ceilinghost${String(index).padStart(5, '0')}`)
    const flagSets: EdgeControlFlags[] = [
      { mode: 'on', leaveCeilingPermille: 0, rolloutPermille: 300 },
      { mode: 'on', leaveCeilingPermille: 100, regionRolloutPermille: { 'us-central1': 700 } },
      { mode: 'on', leaveCeilingPermille: 0, regionRolloutPermille: { 'asia-east2': 900 } },
      { mode: 'on', leaveCeilingPermille: 50 }
    ]
    let admitted = 0
    for (const flags of flagSets) {
      const config: EdgeRelayConfig = {
        cellUrl: EDGE_URL,
        rolloutPercent: 20,
        allowHosts: new Set(),
        denyHosts: new Set(),
        regions: new Set(['us-central1']),
        control: () => flags
      }
      for (const relayHostId of hosts) {
        for (const region of ['us-central1', 'asia-east2'] as const) {
          if (inEdgeCohort(config, relayHostId, region, USER, null)) {
            admitted += 1
            expect(mayBeOnEdge(config, relayHostId, USER)).toBe(true)
          }
        }
      }
    }
    expect(admitted).toBeGreaterThan(0)
    expect(hosts.some((relayHostId) => edgeCohortBucketPermille(relayHostId) >= 900)).toBe(true)
  })
})

describe('dormant-assignments reads a bounded window of keys per call', () => {
  it(`returns a cursor and no candidate when ${DORMANT_PAGE_SCAN_MAX} keys held none`, async () => {
    const h = await harness()
    // Keys that sort before the one candidate, all on another cell.
    const others = Array.from({ length: DORMANT_PAGE_SCAN_MAX }, (_, index) => `aaother${String(index).padStart(9, '0')}`)
    for (let start = 0; start < others.length; start += 500) {
      const batch = others.slice(start, start + 500)
      await h.database.query(
        `INSERT INTO relay_assignments
         (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
          reserved_controls, reserved_splices, reserved_invites, pending_installs,
          pending_confirmations, migration_leases)
         VALUES ${batch.map(() => `(?, ?, ?, 1, 0, 0, 0, 0, 0, 0, 0, 0)`).join(', ')}`,
        batch.flatMap((relayHostId) => [USER, relayHostId, OTHER.id])
      )
    }
    await h.placeRow('zzcandidate00001')
    const first = (await (await h.list({ cellId: RETIRING.id })).json()) as { candidates: unknown[]; cursor: string | null }
    expect(first.candidates).toEqual([])
    expect(first.cursor).toEqual(expect.any(String))
    const second = (await (await h.list({ cellId: RETIRING.id, cursor: first.cursor })).json()) as {
      candidates: Array<{ relayHostId: string }>
      cursor: string | null
    }
    expect(second.candidates.map((candidate) => candidate.relayHostId)).toEqual(['zzcandidate00001'])
    expect(second.cursor).toBeNull()
  })
})
