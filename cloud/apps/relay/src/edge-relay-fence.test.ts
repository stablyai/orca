import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database/database.js'
import type { EdgeAdmin, EdgeAdminCallOptions, EdgeAssignBody, EdgeAssignResult } from './edge-admin-client.js'
import { EDGE_FENCE_RETRY_BASE_MS, retryPendingFences } from './edge-relay-fence.js'
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

class ScriptedEdge implements EdgeAdmin {
  answers: EdgeAssignResult['outcome'][] = []
  calls: { body: EdgeAssignBody; options?: EdgeAdminCallOptions }[] = []

  async assign(body: EdgeAssignBody, options?: EdgeAdminCallOptions): Promise<EdgeAssignResult> {
    this.calls.push({ body, ...(options ? { options } : {}) })
    const outcome = this.answers.shift() ?? 'applied'
    return { outcome, assignmentEpoch: outcome === 'stale' ? body.assignmentEpoch + 5 : body.assignmentEpoch }
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
