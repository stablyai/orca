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
import { EDGE_EVACUATION_BUSY_INTERVAL_MS, EDGE_EVACUATION_CONCURRENCY, EDGE_EVACUATION_CONTROL_DELAY_MS, EdgeEvacuation } from './edge-relay-evacuation.js'
import { EDGE_CELL_ID, type EdgeRelayConfig } from './edge-relay.js'
import type { EdgeControlFlags } from './edge-relay-control.js'

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
  // Set: each drain waits for release(), so the test can count drains in flight.
  holding = false
  readonly held: (() => void)[] = []

  release(): void {
    for (const resolve of this.held.splice(0)) { resolve() }
  }

  async assign(): Promise<never> {
    throw new Error('unexpected assign')
  }

  async exportHost(): Promise<never> {
    throw new Error('unexpected export')
  }

  async drain(relayHostId: string): Promise<EdgeDrainResult> {
    if (this.unavailable.has(relayHostId)) { throw new EdgeAdminUnavailableError('status_404') }
    this.drained.push(relayHostId)
    if (this.holding) { await new Promise<void>((resolve) => this.held.push(resolve)) }
    return this.answer
  }
}

async function harness(overrides: Partial<EdgeRelayConfig> = {}, random = 0.5) {
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
  const evacuation = new EdgeEvacuation(database, config, admin, EDGE_CELL_ID, () => clock.now, () => random)
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

describe('edge evacuation under runtime control', () => {

  it('re-arms after a pass that was running when the control changed', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const flags: EdgeControlFlags = { mode: 'on', rolloutPermille: 0 }
    const h = await harness({ control: () => flags })
    await h.insert(hostId(1))
    h.admin.holding = true
    const sweep = vi.spyOn(h.evacuation, 'sweep')
    h.evacuation.start()
    await vi.advanceTimersByTimeAsync(EDGE_EVACUATION_BUSY_INTERVAL_MS)
    expect(h.admin.held).toHaveLength(1)
    flags.mode = 'down'
    h.evacuation.controlChanged()
    h.admin.release()
    await vi.advanceTimersByTimeAsync(EDGE_EVACUATION_CONTROL_DELAY_MS)
    expect(sweep).toHaveBeenCalledTimes(2)
    h.evacuation.stop()
  })

  it('leaves region scope to the assign path: a stored preference outside it drains nobody', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const flags: EdgeControlFlags = { mode: 'on', rolloutPermille: 1000 }
    const h = await harness({ control: () => flags })
    // On the edge by its ask (no region, or us-central1); its stored preference says otherwise.
    await h.insert(hostId(1))
    await h.prefer(hostId(1), 'asia-east2')
    await h.insert(hostId(2))
    expect(await h.evacuation.sweep()).toBe(0)
    expect(h.admin.drained).toEqual([])
    // Leaving the cohort still drains, whatever the stored region.
    flags.rolloutPermille = 0
    expect(await h.evacuation.sweep()).toBe(2)
    expect(h.admin.drained.sort()).toEqual([hostId(1), hostId(2)])
  })

  it(`sends at most ${EDGE_EVACUATION_CONCURRENCY} drains at once`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness()
    for (let index = 0; index < 35; index += 1) { await h.insert(hostId(index)) }
    h.admin.holding = true
    let done = false
    const pass = h.evacuation.sweep().then((answered) => {
      done = true
      return answered
    })
    let most = 0
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      most = Math.max(most, h.admin.held.length)
      h.admin.release()
    }
    expect(await pass).toBe(35)
    expect(most).toBe(EDGE_EVACUATION_CONCURRENCY)
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
})
