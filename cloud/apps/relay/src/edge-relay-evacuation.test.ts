import { createHash } from 'node:crypto'
import { jwtVerify } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database/database.js'
import {
  EDGE_ADMIN_AUDIENCE,
  EdgeAdminUnavailableError,
  createEdgeAdmin,
  type EdgeAdmin,
  type EdgeDrainResult
} from './edge-admin-client.js'
import { EDGE_EVACUATION_BATCH, EDGE_EVACUATION_INTERVAL_MS, EdgeEvacuation } from './edge-relay-evacuation.js'
import { EDGE_CELL_ID, type EdgeRelayConfig } from './edge-relay.js'

const EDGE_URL = 'https://edge.relay.example.test'
const SIGNING_KEY = new TextEncoder().encode('edge-admin-key-with-at-least-32-bytes!!')

const databases: RelayDatabase[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) { await database.close() }
})

function hostId(index: number): string {
  return `host${String(index).padStart(12, '0')}`
}

class FakeAdmin implements EdgeAdmin {
  drained: string[] = []
  unavailable = new Set<string>()
  answer: EdgeDrainResult = { outcome: 'drained', controls: 1 }

  async assign(): Promise<never> {
    throw new Error('unexpected assign')
  }

  async exportHost(): Promise<never> {
    throw new Error('unexpected export')
  }

  async drain(relayHostId: string): Promise<EdgeDrainResult> {
    if (this.unavailable.has(relayHostId)) { throw new EdgeAdminUnavailableError('status_404') }
    this.drained.push(relayHostId)
    return this.answer
  }
}

async function harness(overrides: Partial<EdgeRelayConfig> = {}) {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  const config: EdgeRelayConfig = {
    cellUrl: EDGE_URL,
    rolloutPercent: 0,
    allowHosts: new Set(),
    denyHosts: new Set(),
    regions: new Set(['us-central1']),
    ...overrides
  }
  const admin = new FakeAdmin()
  const clock = { now: 1_700_000_000_000 }
  const evacuation = new EdgeEvacuation(database, config, admin, EDGE_CELL_ID, () => clock.now, () => 0.5)
  const insert = async (relayHostId: string, cellId = EDGE_CELL_ID, userId = 'user-1') =>
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
        reserved_controls, reserved_splices, reserved_invites, pending_installs,
        pending_confirmations, migration_leases)
       VALUES (?, ?, ?, 1, 0, 0, 0, 0, 0, 0, 0, 0)`,
      [userId, relayHostId, cellId]
    )
  const prefer = async (relayHostId: string, region: string, userId = 'user-1') =>
    await database.query(
      `INSERT INTO relay_assignment_region_preferences (user_id, relay_host_id, preferred_region, observed_at)
       VALUES (?, ?, ?, 0)`,
      [userId, relayHostId, region]
    )
  return { database, config, admin, clock, evacuation, insert, prefer }
}

describe('edge evacuation sweep', () => {
  it('drains only edge rows whose host left the cohort, and logs the outcome', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness({ allowHosts: new Set([hostId(1)]), denyHosts: new Set([hostId(2)]) })
    await h.insert(hostId(1))
    await h.insert(hostId(2))
    await h.insert(hostId(3), 'us-c1')
    expect(await h.evacuation.sweep()).toBe(1)
    expect(h.admin.drained).toEqual([hostId(2)])
    const events = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    expect(events).toEqual([{ event: 'orca_relay_edge_drain_sent', outcome: 'drained', controls: 1 }])
  })

  it('reads the region from the stored preference, else the default region', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness({ allowUsers: new Set(['user-team']) })
    await h.insert(hostId(1), EDGE_CELL_ID, 'user-team')
    await h.insert(hostId(2), EDGE_CELL_ID, 'user-team')
    await h.insert(hostId(3), EDGE_CELL_ID, 'user-team')
    await h.prefer(hostId(1), 'asia-east2', 'user-team')
    await h.prefer(hostId(2), 'us-central1', 'user-team')
    await h.evacuation.sweep()
    expect(h.admin.drained).toEqual([hostId(1)])
  })

  it(`drains at most ${EDGE_EVACUATION_BATCH} per tick, the rest on the next, and not again within the cooldown`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness()
    for (let index = 0; index < 25; index += 1) { await h.insert(hostId(index)) }
    h.admin.answer = { outcome: 'idle' }
    expect(await h.evacuation.sweep()).toBe(EDGE_EVACUATION_BATCH)
    expect(await h.evacuation.sweep()).toBe(5)
    expect(new Set(h.admin.drained).size).toBe(25)
    expect(await h.evacuation.sweep()).toBe(0)
    h.clock.now += 10 * 60_000
    expect(await h.evacuation.sweep()).toBe(EDGE_EVACUATION_BATCH)
  })

  it('logs an unavailable edge and carries on with the next host, retrying it later', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness()
    await h.insert(hostId(1))
    await h.insert(hostId(2))
    h.admin.unavailable.add(hostId(1))
    expect(await h.evacuation.sweep()).toBe(1)
    expect(h.admin.drained).toEqual([hostId(2)])
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({
      event: 'orca_relay_edge_drain_failed',
      reason: 'relay_edge_admin_unavailable:status_404'
    })
    h.admin.unavailable.clear()
    expect(await h.evacuation.sweep()).toBe(1)
    expect(h.admin.drained).toEqual([hostId(2), hostId(1)])
  })

  it('runs on a jittered timer from start until stop', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness()
    await h.insert(hostId(1))
    const sweep = vi.spyOn(h.evacuation, 'sweep')
    h.evacuation.start()
    await vi.advanceTimersByTimeAsync(EDGE_EVACUATION_INTERVAL_MS - 1)
    expect(sweep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sweep).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(h.admin.drained).toEqual([hostId(1)]))
    h.evacuation.stop()
    await vi.advanceTimersByTimeAsync(10 * EDGE_EVACUATION_INTERVAL_MS)
    expect(sweep).toHaveBeenCalledTimes(1)
  })
})

describe('edge admin drain call', () => {
  it('posts the signed drain op and reads both answers; anything else is unavailable', async () => {
    const answers: [number, unknown][] = [
      [200, { outcome: 'drained', controls: 2 }],
      [200, { outcome: 'idle' }],
      [404, {}],
      [401, {}],
      [200, { outcome: 'drained' }]
    ]
    const requests: { url: string; init: RequestInit }[] = []
    const admin = createEdgeAdmin({
      cellUrl: EDGE_URL,
      signingKey: SIGNING_KEY,
      issuer: 'https://relay.example.test',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init! })
        const [status, body] = answers.shift()!
        return new Response(JSON.stringify(body), { status })
      }
    })
    expect(await admin.drain(hostId(1))).toEqual({ outcome: 'drained', controls: 2 })
    expect(await admin.drain(hostId(1))).toEqual({ outcome: 'idle' })
    await expect(admin.drain(hostId(1))).rejects.toBeInstanceOf(EdgeAdminUnavailableError)
    await expect(admin.drain(hostId(1))).rejects.toBeInstanceOf(EdgeAdminUnavailableError)
    await expect(admin.drain(hostId(1))).rejects.toBeInstanceOf(EdgeAdminUnavailableError)
    const first = requests[0]!
    expect(first.url).toBe(`${EDGE_URL}/__admin/drain`)
    expect(first.init.method).toBe('POST')
    expect(first.init.body).toBe(JSON.stringify({ relayHostId: hostId(1) }))
    const token = String((first.init.headers as Record<string, string>).authorization).replace('Bearer ', '')
    const { payload } = await jwtVerify(token, SIGNING_KEY, {
      audience: EDGE_ADMIN_AUDIENCE,
      issuer: 'https://relay.example.test'
    })
    expect(payload).toMatchObject({
      purpose: 'edge-admin',
      op: 'drain',
      bodySha256: createHash('sha256').update(String(first.init.body)).digest('base64url')
    })
  })

  it('treats a network failure as unavailable', async () => {
    const admin = createEdgeAdmin({
      cellUrl: EDGE_URL,
      signingKey: SIGNING_KEY,
      issuer: 'https://relay.example.test',
      fetch: async () => {
        throw new TypeError('fetch failed')
      }
    })
    await expect(admin.drain(hostId(1))).rejects.toThrow('relay_edge_admin_unavailable:network')
  })
})
