import type { RelayRegion } from '@orca-cloud/relay-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { CellReserveClient } from './cell-reserve-client.js'
import type { RelayCellConfig, RelayConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import { ReserveAssignment } from './reserve-assignment.js'
import { ReservePlacer } from './reserve-placement.js'
import { ShadowSeatDirectory, type SeatFeedCell } from './shadow-seat-directory.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({ sub: 'user-1', relayHostId: token }))
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

// Exercise real /v1/assign plan/store with no database-mode cells; booking fakes enforce two seats per cell.

const CEILING = 2
const CELLS: RelayCellConfig[] = [
  { id: 'us-r', url: 'https://us-r.example.com', region: 'us-central1', capacityRequests: 100 },
  { id: 'asia-r', url: 'https://asia-r.example.com', region: 'asia-east2', capacityRequests: 100 }
]

describe('an all-reserve two-region fleet', () => {
  let database: RelayDatabase
  let store: RelayAssignmentStore
  let reserve: ReserveAssignment
  let now = 100_000
  const booked = new Map<string, number>()

  beforeEach(async () => {
    now = 100_000
    booked.clear()
    database = await openInMemoryRelayDatabase()
    store = new RelayAssignmentStore(database, () => now)
    await store.reconcileCells(CELLS)
    for (const cell of CELLS) {
      await store.setCellAdmitMode(cell.id, 'reserve')
    }
    const feedCells: SeatFeedCell[] = CELLS.map((cell) => ({
      cellId: cell.id,
      cellUrl: cell.url,
      region: cell.region as RelayRegion,
      heartbeatExpiresAt: Number.MAX_SAFE_INTEGER,
      requiredForComplete: true,
      general: true
    }))
    const directory = new ShadowSeatDirectory()
    directory.setCells(CELLS.map((cell) => cell.id))
    for (const cell of CELLS) {
      directory.apply(
        cell.id,
        {
          v: 1,
          cellId: cell.id,
          incarnation: `${cell.id}-1`,
          seq: 1,
          at: 0,
          counts: { seats: 0, controls: 0, bookings: 0, units: 0, ceiling: CEILING },
          intake: { perSec: 100, burst: 20, tokens: 20 },
          flagsApplied: { generation: 1, flags: { admitMode: 'reserve' } },
          full: []
        },
        now - 1_000,
        now
      )
    }
    const client = {
      reserve: async (target: { cellId: string }) => {
        const count = booked.get(target.cellId) ?? 0
        if (count >= CEILING) {
          return { outcome: 'full' }
        }
        booked.set(target.cellId, count + 1)
        return { outcome: 'ok' }
      },
      demote: async () => 'demoted'
    } satisfies Pick<CellReserveClient, 'reserve' | 'demote'>
    const placer = new ReservePlacer(() => now, () => 0.25)
    reserve = new ReserveAssignment({
      mode: 'on',
      directory,
      cells: () => feedCells,
      startedAt: 0,
      placer,
      // SAFETY: only reserve and demote are called, and both are implemented above.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above.
      client: client as unknown as CellReserveClient,
      readRow: async () => null,
      now: () => now,
      random: () => 0.25,
      log: () => undefined
    })
    // A director's estimate starts empty; the first look starts the refill clock.
    for (const cell of reserve.placementCells()) {
      placer.hasBudget(cell)
    }
    now += 1_000
  })

  afterEach(async () => await database.close())

  it('seats US hosts on the Asia reserve cell once US is full, counted as fallbacks, then refuses', async () => {
    const recordRegionSelection = vi.fn()
    const app = createRelayApp(config(), {
      store: {} as never,
      assignments: store,
      reservePlacement: reserve,
      drain: vi.fn(),
      ready: vi.fn(async () => true),
      recordRegionSelection
    })
    const ask = async (host: number) => {
      const relayHostId = `fleethost${String(host).padStart(7, '0')}`
      return await app.request('/v1/assign', {
        method: 'POST',
        headers: { authorization: `Bearer ${relayHostId}`, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, relayHostId, preferredRegion: 'us-central1' })
      })
    }
    const cellUrls: string[] = []
    for (let host = 0; host < 2 * CEILING; host++) {
      const response = await ask(host)
      expect(response.status).toBe(200)
      cellUrls.push(((await response.json()) as { cellUrl: string }).cellUrl)
    }
    expect(cellUrls).toEqual([CELLS[0]!.url, CELLS[0]!.url, CELLS[1]!.url, CELLS[1]!.url])
    expect(recordRegionSelection.mock.calls.map(([input]) => input.fallback)).toEqual([false, false, true, true])
    const refused = await ask(2 * CEILING)
    expect(refused.status).toBe(503)
    expect(await refused.json()).toEqual({ error: 'relay_capacity_exhausted' })
    expect(await database.query(`SELECT cell_id FROM relay_assignments`)).toEqual([])
  })
})

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
