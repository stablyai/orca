import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'

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
import { RelayAssignmentStore } from './assignment-store.js'
import type { CellReserveClient } from './cell-reserve-client.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import { ReserveAssignment, type ReservePlacementMode } from './reserve-assignment.js'
import { ReservePlacer } from './reserve-placement.js'
import { ShadowSeatDirectory, type SeatFeedCell, type SeatFeedResponse } from './shadow-seat-directory.js'

const INCARNATION = '11111111-1111-4111-8111-111111111111'
const CELLS = [
  { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
  { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
]
const PER_HOST_FIELDS = [
  'reservedRequests',
  'assignments',
  'activityLeases',
  'activityRequestUnits',
  'restartBlockingActivityLeases',
  'restartBlockingActivityRequestUnits',
  'restartBlockingReservedRequests',
  'outgoingMigrations',
  'incomingMigrations'
]

function feed(cellId: string, overrides: Partial<SeatFeedResponse> = {}): SeatFeedResponse {
  return {
    v: 1,
    cellId,
    incarnation: INCARNATION,
    seq: 1,
    at: 0,
    draining: false,
    counts: { seats: 40, controls: 42, bookings: 3, units: 45, ceiling: 500 },
    intake: { perSec: 5, burst: 20, tokens: 20 },
    flagsApplied: { generation: 3, flags: { admitMode: 'reserve' } },
    admitModeEffective: 'reserve',
    admitModeRaw: 'reserve',
    full: [],
    ...overrides
  }
}

describe('reserve-aware cell status', () => {
  let database: RelayDatabase | undefined

  afterEach(async () => {
    await database?.close()
    database = undefined
  })

  async function setup(options: { mode?: ReservePlacementMode; startedAt?: number; placement?: boolean } = {}) {
    const now = { value: 100_000 }
    database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, () => now.value, { heartbeatTtlMs: 45_000 })
    await store.reconcileCells(CELLS)
    for (const cell of CELLS) {
      await store.recordCellHeartbeat({
        cellId: cell.id,
        cellUrl: cell.url,
        cellIncarnation: INCARNATION,
        startedAt: 50,
        ready: true,
        observedRequests: 0
      })
    }
    await store.assign({ userId: 'user-a', relayHostId: 'host000000000001' })
    await store.setCellAdmitMode('cell-a', 'reserve')
    const cells: SeatFeedCell[] = CELLS.map((cell) => ({
      cellId: cell.id,
      cellUrl: cell.url,
      region: 'us-central1',
      heartbeatExpiresAt: Number.MAX_SAFE_INTEGER,
      requiredForComplete: true,
      general: true
    }))
    const directory = new ShadowSeatDirectory()
    directory.setCells(cells.map((cell) => cell.cellId))
    const reservePlacement = new ReserveAssignment({
      mode: options.mode ?? 'on',
      directory,
      cells: () => cells,
      startedAt: options.startedAt ?? 0,
      placer: new ReservePlacer(() => now.value, () => 0.25),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the status route never books or demotes.
      client: {} as CellReserveClient,
      readRow: async () => null,
      now: () => now.value
    })
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: store,
      ...(options.placement === false ? {} : { reservePlacement }),
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })
    const status = async (body: Record<string, unknown>) =>
      await app.request('/v1/admin/cell-status', {
        method: 'POST',
        headers: { authorization: 'Bearer deploy-token', 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, ...body })
      })
    return { store, directory, now, status }
  }

  it('reads a database cell exactly as today, and leaves a reserve cell without per-host counts', async () => {
    const { store } = await setup()
    expect(await store.reserveAwareCellDeploymentStatus('cell-b')).toEqual({
      admitMode: 'db',
      status: await store.cellDeploymentStatus('cell-b')
    })
    await expect(store.cellDeploymentStatus('cell-a')).rejects.toThrow('cell_in_reserve_mode')
    const reserve = await store.reserveAwareCellDeploymentStatus('cell-a')
    expect(reserve).toMatchObject({
      admitMode: 'reserve',
      status: { cellId: 'cell-a', runtime: { cellIncarnation: INCARNATION, ready: true, heartbeatFresh: true } }
    })
    expect(Object.keys(reserve.status).filter((key) => PER_HOST_FIELDS.includes(key))).toEqual([])
    await database!.query('ALTER TABLE relay_cell_admit_modes RENAME TO relay_cell_admit_modes_gone')
    const unknown = new RelayAssignmentStore(database!, () => 100_000)
    await expect(unknown.reserveAwareCellDeploymentStatus('cell-b')).rejects.toThrow('reserve_mode_unknown')
  })

  it('keeps the 404 for a reserve cell without the opt-in, and 400s an unknown view', async () => {
    const { status } = await setup()
    const refused = await status({ cellId: 'cell-a' })
    expect(refused.status).toBe(404)
    expect(await refused.json()).toEqual({ error: 'cell_in_reserve_mode' })
    expect((await status({ cellId: 'cell-a', view: 'all' })).status).toBe(400)
  })

  it('answers a database cell with the opt-in as today, plus reserve: null', async () => {
    const { status } = await setup()
    const today = await statusBody(await status({ cellId: 'cell-b' }))
    const response = await status({ cellId: 'cell-b', view: 'reserve-aware' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ...today, status: { ...today.status, reserve: null } })
  })

  it('answers a reserve cell from the map, with perHost null and never zeros', async () => {
    const { directory, now, status } = await setup()
    directory.apply('cell-a', feed('cell-a', { draining: true }), now.value, now.value - 1_500)
    directory.apply('cell-b', feed('cell-b', { admitModeEffective: 'db', admitModeRaw: 'db' }), now.value, now.value)
    now.value += 20_000
    const response = await status({ cellId: 'cell-a', view: 'reserve-aware' })
    expect(response.status).toBe(200)
    const body = await statusBody(response)
    expect(body.status).toMatchObject({
      cellId: 'cell-a',
      admissionState: 'general',
      runtime: { cellIncarnation: INCARNATION },
      perHost: null,
      reserve: {
        admitMode: 'reserve',
        feedStatus: 'live',
        // Reported, not enforced: the caller rejects a stale map.
        polledAgeMs: 21_500,
        incarnation: INCARNATION,
        draining: true,
        controls: 42,
        seats: 40,
        bookings: 3,
        units: 45,
        ceiling: 500,
        intakePerSec: 5,
        free: 500 - (45 - 3) - 3
      }
    })
    expect(Object.keys(body.status).filter((key) => PER_HOST_FIELDS.includes(key))).toEqual([])
  })

  it('reports nulls, not zeros, for a restarted cell that has not applied its reserve switch', async () => {
    const { directory, now, status } = await setup()
    directory.apply(
      'cell-a',
      feed('cell-a', {
        counts: { seats: 0, controls: 0 },
        intake: undefined,
        flagsApplied: { generation: 0, flags: {} },
        admitModeEffective: 'db',
        admitModeRaw: 'db'
      }),
      now.value,
      now.value
    )
    const body = await statusBody(await status({ cellId: 'cell-a', view: 'reserve-aware' }))
    expect(body.status.reserve).toMatchObject({
      admitMode: 'db',
      bookings: null,
      units: null,
      ceiling: null,
      intakePerSec: null,
      free: null
    })
  })

  it('answers a retryable 503 while this director cannot vouch for the cell', async () => {
    const unavailable = async (response: Response) => ({
      status: response.status,
      retryAfter: response.headers.get('Retry-After'),
      body: await response.json()
    })
    const expected = (reason: string) => ({
      status: 503,
      retryAfter: '5',
      body: { error: 'reserve_status_unavailable', reason }
    })
    for (const options of [{ mode: 'dry-run' as const }, { placement: false }]) {
      const { directory, now, status } = await setup(options)
      directory.apply('cell-a', feed('cell-a'), now.value, now.value)
      expect(await unavailable(await status({ cellId: 'cell-a', view: 'reserve-aware' }))).toEqual(
        expected('placement-off')
      )
      await database?.close()
    }
    // A starting director with one cell unheard.
    const starting = await setup({ startedAt: 99_000 })
    starting.directory.apply('cell-a', feed('cell-a'), starting.now.value, starting.now.value)
    expect(await unavailable(await starting.status({ cellId: 'cell-a', view: 'reserve-aware' }))).toEqual(
      expected('map-incomplete')
    )
    await database?.close()
    const { directory, now, status } = await setup()
    directory.apply('cell-b', feed('cell-b'), now.value, now.value)
    directory.markNoFeed('cell-a', now.value)
    expect(await unavailable(await status({ cellId: 'cell-a', view: 'reserve-aware' }))).toEqual(expected('no-feed'))
    // A feed without the drain flag or counts is an older image: no feed, never an empty cell.
    directory.apply('cell-a', feed('cell-a', { draining: undefined }), now.value, now.value)
    expect(await unavailable(await status({ cellId: 'cell-a', view: 'reserve-aware' }))).toEqual(expected('no-feed'))
    directory.apply('cell-a', feed('cell-a', { counts: undefined }), now.value, now.value)
    expect(await unavailable(await status({ cellId: 'cell-a', view: 'reserve-aware' }))).toEqual(expected('no-feed'))
    // The process that answered the feed is not the one heartbeating the runtime row.
    directory.apply(
      'cell-a',
      feed('cell-a', { incarnation: '22222222-2222-4222-8222-222222222222' }),
      now.value,
      now.value
    )
    expect(await unavailable(await status({ cellId: 'cell-a', view: 'reserve-aware' }))).toEqual(
      expected('incarnation-mismatch')
    )
  })

  it('probes rehome trust on a reserve cell from its runtime rows', async () => {
    const { store } = await setup()
    await database!.query(
      `INSERT INTO relay_cell_capabilities (cell_id, cell_incarnation, regional_rehome_protocol, last_heartbeat_at)
       VALUES ('cell-a', ?, 1, 100000)`,
      [INCARNATION]
    )
    const sourceFetch = vi.fn(async () =>
      Response.json({ v: 1, outcome: 'host-not-connected', sharedRuntimeIdentityRejected: true })
    )
    const app = createRelayApp(
      config({
        rehomeDirectorServiceAccount: 'relay-director@example.test',
        rehomeAudience: 'https://relay.example.test/v1/admin/host-drain'
      }),
      {
        store: {} as never,
        assignments: store,
        drain: vi.fn(),
        regionalRehomeIdentityToken: vi.fn(async () => 'rehome-token'),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the probe only awaits a Response.
        regionalRehomeFetch: sourceFetch as unknown as typeof fetch,
        ready: vi.fn(async () => true)
      }
    )
    const response = await app.request('/v1/admin/regional-rehome-trust-probe', {
      method: 'POST',
      headers: { authorization: 'Bearer deploy-token', 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, sourceCellId: 'cell-a', sourceCellIncarnation: INCARNATION })
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ proven: true })
    expect(sourceFetch).toHaveBeenCalledTimes(2)
  })
})

async function statusBody(response: Response) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the route answers { v, status } on 200.
  return (await response.json()) as { v: number; status: Record<string, unknown> }
}

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://relay.example.test',
    cellUrl: 'https://relay.example.test',
    region: 'us-central1',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: new Uint8Array(32),
    role: 'director',
    cellId: 'director',
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    runtimeServiceAccount: 'relay-cell@example.test',
    adminJwksUrl: 'https://auth.example.test/jwks',
    databasePoolMax: 10,
    publicAssignmentsEnabled: true,
    publicAssignmentConcurrency: 2,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './data',
    ...overrides
  }
}
