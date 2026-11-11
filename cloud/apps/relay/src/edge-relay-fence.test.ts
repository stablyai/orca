import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database/database.js'
import { EdgeAdminUnavailableError, type EdgeAdmin, type EdgeAdminCallOptions, type EdgeAssignBody, type EdgeAssignResult } from './edge-admin-client.js'
import { EDGE_FENCE_RETRY_BASE_MS, EDGE_FENCE_RETRY_BATCH, recordPendingFence, retryPendingFences } from './edge-relay-fence.js'
import { EDGE_CELL_ID, EdgeAssignments, type EdgeRelayConfig } from './edge-relay.js'

const EDGE_URL = 'https://edge.relay.example.test'
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
})

describe('relay edge fence over a same-epoch conflict', () => {
  it('fences once more one epoch above a conflict at its epoch, and never bumps over a stale answer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness()
    h.edge.answers = ['conflict', 'applied']
    expect(await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 9)).toBe(true)
    expect(h.edge.calls.map((call) => call.body.assignmentEpoch)).toEqual([9, 10])
    expect(h.edge.calls.every((call) => call.body.cellId === 'us-c1')).toBe(true)
    expect(logged(warn, 'orca_relay_edge_fence_above_conflict')).toEqual([
      { event: 'orca_relay_edge_fence_above_conflict', outcome: 'applied', assignmentEpoch: 10 }
    ])
    expect(await h.pending()).toEqual([])
    // Stale: the edge holds a newer epoch (the host may be back there); no bump, recorded for retry.
    h.edge.calls = []
    h.edge.answers = ['stale']
    expect(await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 11)).toBe(false)
    expect(h.edge.calls.map((call) => call.body.assignmentEpoch)).toEqual([11])
  })

  it('a pending fence retried into a same-epoch conflict lands one epoch above the row', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await harness()
    await h.placeRow('us-c1', 7)
    h.edge.answers = ['down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down']
    expect(await h.assignments.fenceAway({ userId: USER, relayHostId: HOST }, 'us-c1', 7)).toBe(false)
    expect(await h.pending()).toHaveLength(1)
    h.edge.calls = []
    h.edge.answers = ['conflict', 'applied']
    h.clock.now += 60_000
    await h.retry()
    expect(h.edge.calls.map((call) => call.body.assignmentEpoch)).toEqual([7, 8])
    expect(await h.pending()).toEqual([])
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
})
