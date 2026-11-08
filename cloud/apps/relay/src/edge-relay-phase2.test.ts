import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database/database.js'
import {
  EdgeAdminUnavailableError,
  type EdgeAdmin,
  type EdgeAssignBody,
  type EdgeDeviceRow
} from './edge-admin-client.js'
import { EDGE_CELL_ID, EDGE_EXPORT_SKIP_AFTER_MS, EdgeAssignments, type EdgeRelayConfig } from './edge-relay.js'
import type { EdgeControlFlags } from './edge-relay-control.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({ sub: 'user-1', relayHostId: token }))
}))

vi.mock('./authentication/relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

const EDGE_URL = 'https://edge.relay.example.test'
const HOST = 'edgecohorthost01'
const USER = 'user-1'

const databases: RelayDatabase[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) { await database.close() }
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

function device(id: string, extra: Partial<EdgeDeviceRow> = {}): EdgeDeviceRow {
  return {
    user_id: USER,
    relay_host_id: HOST,
    relay_device_id: id,
    current_hash: `hash-${id}`,
    current_version: 1,
    current_expires_at: 2_000_000_000_000,
    grace_hash: null,
    grace_version: null,
    grace_expires_at: null,
    revoked_at: null,
    updated_at: 1_700_000_000_000,
    ...extra
  }
}

// The edge's rules (relay-edge object-store.ts): epochs only move forward; same epoch must be the
// same placement; export is refused while the desktop is connected.
class FakeEdge implements EdgeAdmin {
  assignment: { userId: string; cellId: string; assignmentEpoch: number } | null = null
  devices: EdgeDeviceRow[] = []
  connected = false
  down = false
  pushes: EdgeAssignBody[] = []
  exports = 0

  async assign(body: EdgeAssignBody) {
    if (this.down) { throw new EdgeAdminUnavailableError('network') }
    this.pushes.push(body)
    const current = this.assignment
    if (current && body.assignmentEpoch < current.assignmentEpoch) {
      return { outcome: 'stale' as const, assignmentEpoch: current.assignmentEpoch }
    }
    if (current && body.assignmentEpoch === current.assignmentEpoch) {
      if (current.cellId !== body.cellId) { return { outcome: 'conflict' as const, assignmentEpoch: current.assignmentEpoch } }
      if (body.devices) { this.devices = body.devices }
      return { outcome: 'unchanged' as const, assignmentEpoch: current.assignmentEpoch }
    }
    this.assignment = { userId: body.userId, cellId: body.cellId, assignmentEpoch: body.assignmentEpoch }
    if (body.cellId === EDGE_CELL_ID && body.devices) { this.devices = body.devices }
    return { outcome: 'applied' as const, assignmentEpoch: body.assignmentEpoch }
  }

  async exportHost() {
    if (this.down) { throw new EdgeAdminUnavailableError('network') }
    this.exports += 1
    if (this.connected) { return { outcome: 'busy' as const } }
    return { outcome: 'exported' as const, assignment: this.assignment, devices: this.devices }
  }

  async drain() {
    return { outcome: 'idle' as const }
  }
}

async function harness(cohort: 'host' | 'account' = 'host', extra: Partial<EdgeRelayConfig> = {}) {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  const edgeConfig: EdgeRelayConfig = {
    cellUrl: EDGE_URL,
    rolloutPercent: 0,
    allowHosts: cohort === 'host' ? new Set([HOST]) : new Set(),
    allowUsers: cohort === 'account' ? new Set([USER]) : new Set(),
    denyHosts: new Set(),
    regions: new Set(['us-central1', 'asia-east2']),
    ...extra
  }
  const fake = new FakeEdge()
  const clock = { now: Date.now() }
  const edge = new EdgeAssignments(database, edgeConfig, () => clock.now, fake)
  await edge.ensureEdgeCell()
  const gce = {
    userId: USER,
    cellId: 'us-c1',
    cellUrl: 'https://us-c1.relay.example.test',
    region: 'us-central1' as const,
    assignmentEpoch: 9,
    leaseExpiresAt: Date.now() + 90_000
  }
  const assignments = {
    assign: vi.fn(async (identity: { relayHostId: string }) => ({ ...gce, relayHostId: identity.relayHostId })),
    resolve: vi.fn(async () => null),
    exchangeRegionCorrection: vi.fn()
  }
  const app = createRelayApp(config(), {
    store: { resolveResume: vi.fn(async () => ({ userId: USER })) } as never,
    assignments: assignments as never,
    reservePlacement: { plan: vi.fn(async () => ({ kind: 'database' })), raiseEpochFloor: vi.fn(), rowEpochFloor: () => 0 } as never,
    edgeAssignments: edge,
    drain: vi.fn(),
    ready: vi.fn(async () => true)
  })
  const assign = async (region = 'us-central1') =>
    await app.request('/v1/assign', {
      method: 'POST',
      headers: { authorization: `Bearer ${HOST}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId: HOST, preferredRegion: region })
    })
  const insertDevice = async (row: EdgeDeviceRow) => {
    const columns = Object.keys(row)
    await database.query(
      `INSERT INTO relay_devices (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(row)
    )
  }
  const postgresDevices = async () =>
    (
      await database.query(
        `SELECT relay_device_id, revoked_at FROM relay_devices WHERE relay_host_id = ? ORDER BY relay_device_id`,
        [HOST]
      )
    ).map((row) => ({ id: String(row.relay_device_id), revoked: row.revoked_at === null ? null : Number(row.revoked_at) }))
  const row = async () =>
    (await database.query(`SELECT cell_id, assignment_epoch FROM relay_assignments WHERE relay_host_id = ?`, [HOST]))[0]
  const leaveCohort = () => (edgeConfig.denyHosts as Set<string>).add(HOST)
  return { database, fake, clock, assignments, assign, insertDevice, postgresDevices, row, leaveCohort }
}

// Asks every 20 s (desktops retry every 2 s; failures further apart than 30 s restart the clock)
// until `ms` after the current time, expecting the 503 each time.
async function keepFailing(h: { clock: { now: number }; assign: () => Promise<Response> }, ms: number) {
  const end = h.clock.now + ms
  while (h.clock.now < end) {
    h.clock.now = Math.min(end, h.clock.now + 20_000)
    if (h.clock.now < end) { expect((await h.assign()).status).toBe(503) }
  }
}

describe('relay edge phase 2: the director moves host data with the host', () => {

  it('keeps the host on today\'s path, with no edge row, when the edge cannot take the push', async () => {
    const h = await harness()
    h.fake.down = true
    const response = await h.assign()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ cellUrl: 'https://us-c1.relay.example.test' })
    expect(await h.row()).toBeUndefined()
  })

  it('503s a leaving host while the edge export is unavailable, until it has failed for 120 s', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const skipped = () => warn.mock.calls.filter(([line]) => String(line).includes('orca_relay_edge_export_skipped'))
    const h = await harness()
    await h.insertDevice(device('phone-a'))
    await h.assign()
    // On the edge phone-a was revoked; the edge then goes down.
    h.fake.devices = [device('phone-a', { revoked_at: 1_800_000_000_000 })]
    h.fake.down = true
    h.leaveCohort()
    expect((await h.assign()).status).toBe(503)
    await keepFailing(h, EDGE_EXPORT_SKIP_AFTER_MS - 1)
    const early = await h.assign()
    expect(early.status).toBe(503)
    expect(early.headers.get('retry-after')).toBe('2')
    expect(h.assignments.assign).not.toHaveBeenCalled()
    expect(skipped()).toHaveLength(0)
    h.clock.now += 1
    const response = await h.assign()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ cellUrl: 'https://us-c1.relay.example.test', assignmentEpoch: 9 })
    // The edge's revoke is unknown here: the host's Postgres devices are removed, never resurrected.
    expect(await h.postgresDevices()).toEqual([])
    expect(skipped()).toHaveLength(1)
    expect(JSON.parse(String(skipped()[0]![0]))).toEqual({
      event: 'orca_relay_edge_export_skipped',
      reason: 'relay_edge_admin_unavailable:network',
      failingForMs: EDGE_EXPORT_SKIP_AFTER_MS,
      devicesRemoved: 1
    })
  })

  it('keeps Postgres devices when the edge object holds no assignment (never pushed or erased)', async () => {
    const h = await harness()
    await h.insertDevice(device('phone-a'))
    await h.assign()
    h.fake.assignment = null
    h.fake.devices = []
    h.leaveCohort()
    expect((await h.assign()).status).toBe(200)
    expect(await h.postgresDevices()).toEqual([{ id: 'phone-a', revoked: null }])
  })

  it('refuses to write devices the edge says belong to another host', async () => {
    const h = await harness()
    await h.insertDevice(device('phone-a'))
    await h.assign()
    h.fake.devices = [device('phone-x', { relay_host_id: 'someotherhost001' })]
    h.leaveCohort()
    expect((await h.assign()).status).toBe(500)
    expect(h.assignments.assign).not.toHaveBeenCalled()
    expect(await h.postgresDevices()).toEqual([{ id: 'phone-a', revoked: null }])
  })

  it('with mode down, skips the export at once, removes the Postgres devices, and fences once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const flags: EdgeControlFlags = { mode: 'on' }
    const h = await harness('host', { control: () => flags })
    await h.insertDevice(device('phone-a'))
    await h.insertDevice(device('phone-b'))
    await h.assign()
    // phone-a was revoked on the edge, which then died; Postgres still holds it live.
    h.fake.devices = [device('phone-a', { revoked_at: 1_800_000_000_000 })]
    h.fake.down = true
    flags.mode = 'down'
    const assign = vi.spyOn(h.fake, 'assign')
    const response = await h.assign()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ cellUrl: 'https://us-c1.relay.example.test', assignmentEpoch: 9 })
    expect(h.fake.exports).toBe(0)
    expect(await h.postgresDevices()).toEqual([])
    const skipped = warn.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((line) => line.event === 'orca_relay_edge_export_skipped')
    expect(skipped).toEqual([{ event: 'orca_relay_edge_export_skipped', reason: 'mode_down', devicesRemoved: 2 }])
    // One fence try, recorded for the sweep to retry.
    expect(assign).toHaveBeenCalledTimes(1)
    const pending = await h.database.query(`SELECT cell_id, assignment_epoch FROM relay_edge_fence_pending`)
    expect(pending.map((row) => [String(row.cell_id), Number(row.assignment_epoch)])).toEqual([['us-c1', 9]])
  })
})
