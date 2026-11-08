import { jwtVerify } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import {
  EDGE_ADMIN_AUDIENCE,
  EDGE_ADMIN_LOCKED_TIMEOUT_MS,
  EdgeAdminUnavailableError,
  createEdgeAdmin,
  type EdgeAdmin,
  type EdgeAdminCallOptions,
  type EdgeAssignBody,
  type EdgeAssignResult
} from './edge-admin-client.js'
import {
  EDGE_CELL_ID,
  EDGE_LOCKED_CALLS_MAX,
  EdgeAssignments,
  EdgeMoveDeferredError,
  type EdgeRelayConfig
} from './edge-relay.js'

const EDGE_URL = 'https://edge.relay.example.test'
const SIGNING_KEY = new TextEncoder().encode('edge-admin-key-with-at-least-32-bytes!!')
const USER = 'user-1'
const HOST = 'fencehost0000001'

const databases: RelayDatabase[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) { await database.close() }
})

type Answer = EdgeAssignResult['outcome'] | 'down' | 'hang'

// Answers each assign from `answers` (then 'applied'); 'hang' waits until `release()`.
class ScriptedEdge implements EdgeAdmin {
  answers: Answer[] = []
  calls: { body: EdgeAssignBody; options?: EdgeAdminCallOptions }[] = []
  private waiting: (() => void)[] = []

  async assign(body: EdgeAssignBody, options?: EdgeAdminCallOptions): Promise<EdgeAssignResult> {
    this.calls.push({ body, ...(options ? { options } : {}) })
    const answer = this.answers.shift() ?? 'applied'
    if (answer === 'down') { throw new EdgeAdminUnavailableError('network') }
    if (answer === 'hang') { await new Promise<void>((resolve) => this.waiting.push(resolve)) }
    const outcome = answer === 'hang' ? 'applied' : answer
    return { outcome, assignmentEpoch: outcome === 'stale' ? body.assignmentEpoch + 5 : body.assignmentEpoch }
  }

  release(): void {
    for (const resolve of this.waiting.splice(0)) { resolve() }
  }

  async exportHost(): Promise<never> {
    throw new Error('unexpected export')
  }

  async drain(): Promise<never> {
    throw new Error('unexpected drain')
  }
}

function edgeConfig(): EdgeRelayConfig {
  return {
    cellUrl: EDGE_URL,
    rolloutPercent: 100,
    allowHosts: new Set(),
    denyHosts: new Set(),
    regions: new Set(['us-central1'])
  }
}

async function harness() {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  const edge = new ScriptedEdge()
  const clock = { now: 1_700_000_000_000 }
  const assignments = new EdgeAssignments(database, edgeConfig(), () => clock.now, edge)
  await assignments.ensureEdgeCell()
  const placeRow = async (cellId: string, epoch: number, relayHostId = HOST) =>
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
        reserved_controls, reserved_splices, reserved_invites, pending_installs,
        pending_confirmations, migration_leases)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0)
       ON CONFLICT (user_id, relay_host_id) DO UPDATE SET cell_id = excluded.cell_id,
         assignment_epoch = excluded.assignment_epoch`,
      [USER, relayHostId, cellId, epoch]
    )
  return { database, edge, clock, assignments, placeRow }
}

function logged(spy: { mock: { calls: unknown[][] } }, event: string): Record<string, unknown>[] {
  return spy.mock.calls
    .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    .filter((entry) => entry.event === event)
}

describe('relay edge fence after a host leaves', () => {
  it('treats a stale answer as a failed fence, logged with its outcome and not retried inline', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await harness()
    h.edge.answers = ['stale']
    expect(await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)).toBe(false)
    expect(h.edge.calls).toHaveLength(1)
    expect(logged(error, 'orca_relay_edge_fence_failed')).toEqual([
      { event: 'orca_relay_edge_fence_failed', outcome: 'stale', cellId: 'us-c1', assignmentEpoch: 9 }
    ])
  })

  it('retries conflict and unavailable inline, then logs the last outcome', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await harness()
    h.edge.answers = ['conflict', 'conflict', 'down']
    expect(await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)).toBe(false)
    expect(h.edge.calls).toHaveLength(3)
    expect(logged(error, 'orca_relay_edge_fence_failed')[0]).toMatchObject({
      outcome: 'relay_edge_admin_unavailable:network'
    })
  })

  it('lands on applied or unchanged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await harness()
    h.edge.answers = ['down', 'unchanged']
    expect(await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)).toBe(true)
    expect(await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)).toBe(true)
    expect(logged(error, 'orca_relay_edge_fence_failed')).toEqual([])
  })
})

describe('relay edge pushes under the row lock', () => {
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

  it(`defers a move once ${EDGE_LOCKED_CALLS_MAX} pushes are in flight, with a ${EDGE_ADMIN_LOCKED_TIMEOUT_MS} ms timeout`, async () => {
    const h = await harness()
    const assignments = new EdgeAssignments(overlapping(h.database), edgeConfig(), () => h.clock.now, h.edge)
    await assignments.ensureEdgeCell()
    h.edge.answers = Array.from({ length: EDGE_LOCKED_CALLS_MAX }, () => 'hang' as const)
    const hostIds = Array.from({ length: EDGE_LOCKED_CALLS_MAX + 1 }, (_, index) => `fencecap${String(index).padStart(8, '0')}`)
    for (const relayHostId of hostIds) { await h.placeRow('us-c1', 3, relayHostId) }
    const held = hostIds.slice(0, EDGE_LOCKED_CALLS_MAX).map((relayHostId) => assignments.moveToEdge({ userId: USER, relayHostId }, 0))
    await vi.waitFor(() => expect(h.edge.calls).toHaveLength(EDGE_LOCKED_CALLS_MAX))
    const last = { userId: USER, relayHostId: hostIds.at(-1)! }
    const deferred = await assignments.moveToEdge(last, 0).catch((error: unknown) => error)
    expect(deferred).toBeInstanceOf(EdgeMoveDeferredError)
    expect((deferred as Error).message).toBe('relay_edge_move_deferred:edge_busy')
    // Not waited for and not sent.
    expect(h.edge.calls).toHaveLength(EDGE_LOCKED_CALLS_MAX)
    h.edge.release()
    await Promise.all(held)
    for (const call of h.edge.calls) { expect(call.options).toEqual({ timeoutMs: EDGE_ADMIN_LOCKED_TIMEOUT_MS }) }
    // Slots are freed: the deferred host moves on its next ask.
    expect((await assignments.moveToEdge(last, 0)).cellId).toBe(EDGE_CELL_ID)
  })
})

describe('edge admin tokens and timeouts', () => {
  it('signs every call with a fresh 128-bit jti', async () => {
    const tokens: string[] = []
    const admin = createEdgeAdmin({
      cellUrl: EDGE_URL,
      signingKey: SIGNING_KEY,
      issuer: 'https://relay.example.test',
      fetch: async (url, init) => {
        tokens.push(String((init!.headers as Record<string, string>).authorization).replace('Bearer ', ''))
        const op = String(url).split('/').at(-1)
        const body =
          op === 'assign'
            ? { outcome: 'applied', assignmentEpoch: 1 }
            : op === 'export'
              ? { outcome: 'exported', assignment: null, devices: [] }
              : { outcome: 'idle' }
        return new Response(JSON.stringify(body), { status: 200 })
      }
    })
    await admin.assign({ userId: USER, relayHostId: HOST, cellId: 'us-c1', assignmentEpoch: 1 })
    await admin.assign({ userId: USER, relayHostId: HOST, cellId: 'us-c1', assignmentEpoch: 1 })
    await admin.exportHost(HOST)
    await admin.drain(HOST)
    const ids = await Promise.all(
      tokens.map(async (token) => {
        const { payload } = await jwtVerify(token, SIGNING_KEY, { audience: EDGE_ADMIN_AUDIENCE })
        return String(payload.jti)
      })
    )
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(Buffer.from(id, 'base64url')).toHaveLength(16)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('times out pushes and exports at 2 s, other calls at 3 s', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const admin = createEdgeAdmin({
      cellUrl: EDGE_URL,
      signingKey: SIGNING_KEY,
      issuer: 'https://relay.example.test',
      fetch: async () => new Response(JSON.stringify({ outcome: 'busy' }), { status: 409 })
    })
    const body = { userId: USER, relayHostId: HOST, cellId: 'us-c1', assignmentEpoch: 1 }
    await admin.assign(body, { timeoutMs: EDGE_ADMIN_LOCKED_TIMEOUT_MS }).catch(() => undefined)
    await admin.assign(body).catch(() => undefined)
    await admin.exportHost(HOST)
    await admin.drain(HOST).catch(() => undefined)
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([2_000, 3_000, 2_000, 3_000])
  })
})
