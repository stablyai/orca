import { createHash } from 'node:crypto'
import { jwtVerify } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import {
  EDGE_ADMIN_AUDIENCE,
  EdgeAdminUnavailableError,
  createEdgeAdmin,
  type EdgeAdmin,
  type EdgeDrainResult
} from './edge-admin-client.js'
import {
  EDGE_EVACUATION_BATCH,
  EDGE_EVACUATION_BUSY_INTERVAL_MS,
  EDGE_EVACUATION_CONCURRENCY,
  EDGE_EVACUATION_CONTROL_DELAY_MS,
  EDGE_EVACUATION_INTERVAL_MS,
  EdgeEvacuation
} from './edge-relay-evacuation.js'
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

  it('leaves region scope to the assign path: a stored preference outside it drains nobody', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness({ allowUsers: new Set(['user-team']) })
    // On the edge by their asks; one stored preference says a region outside the scope.
    await h.insert(hostId(1), EDGE_CELL_ID, 'user-team')
    await h.insert(hostId(2), EDGE_CELL_ID, 'user-team')
    await h.prefer(hostId(1), 'asia-east2', 'user-team')
    await h.prefer(hostId(2), 'us-central1', 'user-team')
    // Not in the cohort at all: drained whatever its stored region.
    await h.insert(hostId(3), EDGE_CELL_ID, 'user-other')
    await h.prefer(hostId(3), 'us-central1', 'user-other')
    await h.evacuation.sweep()
    expect(h.admin.drained).toEqual([hostId(3)])
  })

  it(`drains at most ${EDGE_EVACUATION_BATCH} per tick, the rest on the next, and not again within the cooldown`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness()
    for (let index = 0; index < EDGE_EVACUATION_BATCH + 25; index += 1) { await h.insert(hostId(index)) }
    h.admin.answer = { outcome: 'idle' }
    expect(await h.evacuation.sweep()).toBe(EDGE_EVACUATION_BATCH)
    expect(await h.evacuation.sweep()).toBe(25)
    expect(new Set(h.admin.drained).size).toBe(EDGE_EVACUATION_BATCH + 25)
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
    // First pass soon after start, then the slow interval once nothing more is queued.
    await vi.advanceTimersByTimeAsync(EDGE_EVACUATION_BUSY_INTERVAL_MS - 1)
    expect(sweep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sweep).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.admin.drained).toEqual([hostId(1)])
    await vi.advanceTimersByTimeAsync(EDGE_EVACUATION_BUSY_INTERVAL_MS)
    expect(sweep).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(EDGE_EVACUATION_INTERVAL_MS - EDGE_EVACUATION_BUSY_INTERVAL_MS)
    expect(sweep).toHaveBeenCalledTimes(2)
    h.evacuation.stop()
    await vi.advanceTimersByTimeAsync(10 * EDGE_EVACUATION_INTERVAL_MS)
    expect(sweep).toHaveBeenCalledTimes(2)
  })
})

describe('edge evacuation under runtime control', () => {
  it('re-arms an idle sweep within 5 s of a control change, so a rollback drains at once', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const flags: EdgeControlFlags = { mode: 'on' }
    const h = await harness({ rolloutPercent: 100, control: () => flags })
    await h.insert(hostId(1))
    const sweep = vi.spyOn(h.evacuation, 'sweep')
    h.evacuation.start()
    await vi.advanceTimersByTimeAsync(EDGE_EVACUATION_BUSY_INTERVAL_MS)
    expect(sweep).toHaveBeenCalledTimes(1)
    expect(h.admin.drained).toEqual([])
    // Idle now: the next pass would be ~10 min away.
    await vi.advanceTimersByTimeAsync(60_000)
    flags.mode = 'off'
    h.evacuation.controlChanged()
    await vi.advanceTimersByTimeAsync(EDGE_EVACUATION_CONTROL_DELAY_MS)
    expect(sweep).toHaveBeenCalledTimes(2)
    expect(h.admin.drained).toEqual([hostId(1)])
    h.evacuation.stop()
  })

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

  it('reports an edge row above the leave ceiling (the ceiling was set too low) and still drains it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const flags: EdgeControlFlags = { mode: 'on', rolloutPermille: 0, leaveCeilingPermille: 0 }
    const h = await harness({ control: () => flags })
    await h.insert(hostId(1))
    expect(await h.evacuation.sweep()).toBe(1)
    expect(errors.mock.calls.map((call) => String(call[0]))).toContain(
      JSON.stringify({ event: 'orca_relay_edge_row_above_ceiling' })
    )
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

  it('starts each pass at a random point of the keys and wraps around to it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const users = ['20000000-a', '60000000-a', 'a0000000-a', 'e0000000-a']
    const drainedFrom = async (random: number) => {
      const h = await harness({}, random)
      for (const [index, user] of users.entries()) { await h.insert(hostId(index), EDGE_CELL_ID, user) }
      expect(await h.evacuation.sweep()).toBe(4)
      return h.admin.drained
    }
    expect(await drainedFrom(0.5)).toEqual([hostId(2), hostId(3), hostId(0), hostId(1)])
    expect(await drainedFrom(0.1)).toEqual([hostId(0), hostId(1), hostId(2), hostId(3)])
    expect(await drainedFrom(0.3)).toEqual([hostId(1), hostId(2), hostId(3), hostId(0)])
  })

  it('pages an idle pass: one page of edge rows per tick, then idle until the next pass', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness({ rolloutPercent: 100 })
    for (let index = 0; index < 1_200; index += 1) { await h.insert(hostId(index)) }
    const query = vi.spyOn(h.database, 'query')
    const pages = () => query.mock.calls.filter(([sql]) => String(sql).includes('FROM relay_assignments a')).length
    const busy = () => (h.evacuation as unknown as { busy: boolean }).busy
    await h.evacuation.sweep()
    expect([pages(), busy()]).toEqual([1, true])
    await h.evacuation.sweep()
    expect([pages(), busy()]).toEqual([2, true])
    // The short last page wraps to the start of the keys, which holds nothing before the origin.
    await h.evacuation.sweep()
    expect([pages(), busy()]).toEqual([4, false])
    expect(h.admin.drained).toEqual([])
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
