import { jwtVerify } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database/database.js'
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
import { EDGE_EVACUATION_BUSY_INTERVAL_MS, EdgeEvacuation } from './edge-relay-evacuation.js'
import {
  EDGE_FENCE_MAX_ATTEMPTS,
  EDGE_FENCE_RETRY_BASE_MS,
  EDGE_FENCE_RETRY_BATCH,
  EDGE_FENCE_RETRY_MAX_MS,
  edgeFenceRetryDelayMs,
  recordPendingFence,
  retryPendingFences
} from './edge-relay-fence.js'
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
const T0 = 1_700_000_000_000

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

  get hanging(): number {
    return this.waiting.length
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
  const clock = { now: T0 }
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
  const pending = async () =>
    (await database.query(`SELECT * FROM relay_edge_fence_pending ORDER BY relay_host_id`)).map((row) => ({
      relayHostId: String(row.relay_host_id),
      cellId: String(row.cell_id),
      assignmentEpoch: Number(row.assignment_epoch),
      attempts: Number(row.attempts),
      nextAttemptAt: Number(row.next_attempt_at)
    }))
  const retry = async () => await retryPendingFences(database, edge, EDGE_CELL_ID, () => clock.now)
  return { database, edge, clock, assignments, placeRow, pending, retry }
}

function logged(spy: { mock: { calls: unknown[][] } }, event: string): Record<string, unknown>[] {
  return spy.mock.calls
    .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    .filter((entry) => entry.event === event)
}

describe('relay edge fence after a host leaves', () => {
  it('treats a stale answer as a failed fence: logged with its outcome, recorded, not retried inline', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await harness()
    h.edge.answers = ['stale']
    expect(await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)).toBe(false)
    expect(h.edge.calls).toHaveLength(1)
    expect(logged(error, 'orca_relay_edge_fence_failed')).toEqual([
      { event: 'orca_relay_edge_fence_failed', outcome: 'stale', cellId: 'us-c1', assignmentEpoch: 9 }
    ])
    expect(await h.pending()).toEqual([
      { relayHostId: HOST, cellId: 'us-c1', assignmentEpoch: 9, attempts: 0, nextAttemptAt: T0 + EDGE_FENCE_RETRY_BASE_MS }
    ])
  })

  it('retries conflict and unavailable inline, then records the last outcome', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await harness()
    h.edge.answers = ['conflict', 'down', 'conflict']
    expect(await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)).toBe(false)
    expect(h.edge.calls).toHaveLength(3)
    expect(logged(error, 'orca_relay_edge_fence_failed')[0]).toMatchObject({ outcome: 'conflict' })
    expect(await h.pending()).toHaveLength(1)
  })

  it('records nothing when the fence lands, and a newer failure replaces an older record', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await harness()
    h.edge.answers = ['down', 'unchanged']
    expect(await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)).toBe(true)
    expect(await h.pending()).toEqual([])
    h.edge.answers = ['down', 'down', 'down']
    await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)
    await h.database.query(`UPDATE relay_edge_fence_pending SET attempts = 3`)
    h.clock.now += 5_000
    h.edge.answers = ['stale']
    await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c2', 12)
    expect(await h.pending()).toEqual([
      { relayHostId: HOST, cellId: 'us-c2', assignmentEpoch: 12, attempts: 0, nextAttemptAt: h.clock.now + EDGE_FENCE_RETRY_BASE_MS }
    ])
  })

  it('still answers when the failure cannot be recorded', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await harness()
    await h.database.query(`DROP TABLE relay_edge_fence_pending`)
    h.edge.answers = ['stale']
    expect(await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)).toBe(false)
    expect(logged(error, 'orca_relay_edge_fence_record_failed')).toHaveLength(1)
  })
})

describe('relay edge pending fence retries', () => {
  it('re-fences to the current row, not the recorded one, and clears the record once it lands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await harness()
    h.edge.answers = ['stale']
    await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)
    // The host moved again before the retry.
    await h.placeRow('us-c2', 11)
    h.edge.calls = []
    expect(await h.retry()).toBe(true)
    expect(h.edge.calls).toEqual([])
    h.clock.now += EDGE_FENCE_RETRY_BASE_MS
    expect(await h.retry()).toBe(false)
    expect(h.edge.calls).toEqual([{ body: { userId: USER, relayHostId: HOST, cellId: 'us-c2', assignmentEpoch: 11 } }])
    expect(await h.pending()).toEqual([])
    expect(logged(warn, 'orca_relay_edge_fence_retried')).toEqual([
      { event: 'orca_relay_edge_fence_retried', outcome: 'applied', cellId: 'us-c2', assignmentEpoch: 11, attempts: 1 }
    ])
  })

  it('drops the record without a call when the host is back on the edge or has no row', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await harness()
    h.edge.answers = ['stale', 'stale']
    await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)
    await h.assignments.fenceAway({ userId: USER, relayHostId: 'fencehost0000002' }, 'us-c1', 4)
    await h.placeRow(EDGE_CELL_ID, 12)
    h.edge.calls = []
    h.clock.now += EDGE_FENCE_RETRY_BASE_MS
    expect(await h.retry()).toBe(false)
    expect(h.edge.calls).toEqual([])
    expect(await h.pending()).toEqual([])
  })

  it('backs off on each failure, logging it, and gives up after the last attempt', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await harness()
    await h.placeRow('us-c1', 9)
    h.edge.answers = ['stale']
    await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)
    h.clock.now += EDGE_FENCE_RETRY_BASE_MS
    for (let attempt = 1; attempt < EDGE_FENCE_MAX_ATTEMPTS; attempt += 1) {
      h.edge.answers = [attempt % 2 === 0 ? 'down' : 'conflict']
      expect(await h.retry()).toBe(true)
      expect(await h.pending()).toMatchObject([{ attempts: attempt, nextAttemptAt: h.clock.now + edgeFenceRetryDelayMs(attempt) }])
      // Not due yet: nothing is sent.
      h.clock.now += edgeFenceRetryDelayMs(attempt) - 1
      const calls = h.edge.calls.length
      await h.retry()
      expect(h.edge.calls).toHaveLength(calls)
      h.clock.now += 1
    }
    h.edge.answers = ['stale']
    expect(await h.retry()).toBe(false)
    expect(await h.pending()).toEqual([])
    const failures = logged(error, 'orca_relay_edge_fence_failed').filter((entry) => entry.retry === true)
    expect(failures).toHaveLength(EDGE_FENCE_MAX_ATTEMPTS)
    expect(failures[1]).toEqual({
      event: 'orca_relay_edge_fence_failed',
      outcome: 'relay_edge_admin_unavailable:network',
      cellId: 'us-c1',
      assignmentEpoch: 9,
      attempts: 2,
      retry: true
    })
    expect(logged(error, 'orca_relay_edge_fence_abandoned')).toEqual([
      {
        event: 'orca_relay_edge_fence_abandoned',
        outcome: 'stale',
        cellId: 'us-c1',
        assignmentEpoch: 9,
        attempts: EDGE_FENCE_MAX_ATTEMPTS
      }
    ])
    expect(edgeFenceRetryDelayMs(1)).toBe(60_000)
    expect(edgeFenceRetryDelayMs(EDGE_FENCE_MAX_ATTEMPTS)).toBe(30 * 60_000)
  })

  it('keeps retrying a fence through more than a day of edge outage', () => {
    // Recorded at 0, first retry one base delay later, then each attempt's backoff.
    let lastAttemptAt = EDGE_FENCE_RETRY_BASE_MS
    for (let attempt = 1; attempt < EDGE_FENCE_MAX_ATTEMPTS; attempt += 1) {
      lastAttemptAt += edgeFenceRetryDelayMs(attempt)
    }
    expect(lastAttemptAt).toBeGreaterThanOrEqual(24 * 60 * 60_000)
    // Never slower than the cap, so the edge is not left claiming hosts long after it is back.
    expect(edgeFenceRetryDelayMs(EDGE_FENCE_MAX_ATTEMPTS)).toBe(EDGE_FENCE_RETRY_MAX_MS)
  })

  it(`retries up to ${EDGE_FENCE_RETRY_BATCH} due fences per pass, 10 in flight at once`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness()
    const hosts = Array.from({ length: EDGE_FENCE_RETRY_BATCH + 10 }, (_, index) => `fencehost${String(index).padStart(7, '0')}`)
    for (const host of hosts) {
      await h.placeRow('us-c1', 9, host)
      await recordPendingFence(h.database, { userId: USER, relayHostId: host }, 'us-c1', 9, h.clock.now)
    }
    h.clock.now += EDGE_FENCE_RETRY_BASE_MS
    h.edge.answers = hosts.map(() => 'hang')
    let settled = false
    const pass = h.retry().then((left) => {
      settled = true
      return left
    })
    let maxInFlight = 0
    while (!settled) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      maxInFlight = Math.max(maxInFlight, h.edge.hanging)
      h.edge.release()
    }
    expect(await pass).toBe(true)
    expect(h.edge.calls).toHaveLength(EDGE_FENCE_RETRY_BATCH)
    expect(maxInFlight).toBe(10)
    expect(await h.pending()).toHaveLength(10)
  })

  it('lets only one director claim an attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await harness()
    await h.placeRow('us-c1', 9)
    h.edge.answers = ['stale']
    await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)
    h.clock.now += EDGE_FENCE_RETRY_BASE_MS
    h.edge.calls = []
    await Promise.all([h.retry(), h.retry()])
    expect(h.edge.calls).toHaveLength(1)
  })

  it('runs from the evacuation sweep, which keeps its busy cadence while fences are pending', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = await harness()
    await h.placeRow('us-c1', 9)
    const config = { ...edgeConfig(), rolloutPercent: 0 }
    const evacuation = new EdgeEvacuation(h.database, config, h.edge, EDGE_CELL_ID, () => h.clock.now, () => 0.5)
    h.edge.answers = ['stale']
    await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)
    h.edge.calls = []
    h.edge.answers = ['down']
    const sweep = vi.spyOn(evacuation, 'sweep')
    evacuation.start()
    h.clock.now += EDGE_EVACUATION_BUSY_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(EDGE_EVACUATION_BUSY_INTERVAL_MS)
    expect(h.edge.calls).toHaveLength(1)
    // Still pending: the next pass comes after the busy interval, and lands.
    h.clock.now += EDGE_EVACUATION_BUSY_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(EDGE_EVACUATION_BUSY_INTERVAL_MS)
    expect(sweep).toHaveBeenCalledTimes(2)
    expect(h.edge.calls).toHaveLength(2)
    expect(await h.pending()).toEqual([])
    evacuation.stop()
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
