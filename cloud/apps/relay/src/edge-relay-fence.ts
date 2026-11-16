// Fences that did not land. After a host leaves the relay edge the director tells the edge where it
// went (EdgeAssignments.fenceAway); until that lands the edge object still claims the host and its
// phones get HOST_OFFLINE instead of re-resolving. A failed fence is recorded here, so any director's
// evacuation sweep retries it, always to the host's current row, never to the recorded one.
import type { RelayDatabase } from './database/database.js'
import { EdgeAdminUnavailableError, type EdgeAdmin } from './edge-admin-client.js'
import { integer, text, type Identity } from './edge-relay-cohort.js'

// Retries per pending fence before it is dropped (a fence the edge keeps refusing, e.g. `stale`,
// cannot land until the host moves again, and that move fences anew). Enough to outlast a day-long
// edge outage: the last attempt comes about 25.5 h after the failure.
export const EDGE_FENCE_MAX_ATTEMPTS = 56
// First retry one busy sweep after the failure, doubling up to the cap (31 min to reach it, then
// every 30 min).
export const EDGE_FENCE_RETRY_BASE_MS = 60_000
export const EDGE_FENCE_RETRY_MAX_MS = 30 * 60_000
// Pending fences retried per sweep (per director), with at most EDGE_FENCE_RETRY_CONCURRENCY in flight.
export const EDGE_FENCE_RETRY_BATCH = 50
const EDGE_FENCE_RETRY_CONCURRENCY = 10

export function edgeFenceRetryDelayMs(attempts: number): number {
  return Math.min(EDGE_FENCE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), EDGE_FENCE_RETRY_MAX_MS)
}

// A newer failure for the same host replaces the older one and starts its attempts again.
export async function recordPendingFence(
  database: RelayDatabase,
  identity: Identity,
  cellId: string,
  assignmentEpoch: number,
  now: number
): Promise<void> {
  await database.query(
    `INSERT INTO relay_edge_fence_pending
     (user_id, relay_host_id, cell_id, assignment_epoch, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT (user_id, relay_host_id) DO UPDATE SET
       cell_id = excluded.cell_id, assignment_epoch = excluded.assignment_epoch,
       attempts = 0, next_attempt_at = excluded.next_attempt_at`,
    [identity.userId, identity.relayHostId, cellId, assignmentEpoch, now + EDGE_FENCE_RETRY_BASE_MS]
  )
}

// One fence call. `conflict` means the edge holds this very epoch for another placement (a move onto
// the edge whose push landed though the director counted it as failed, then a placement elsewhere
// minted the same epoch). No later move can produce that (a later move has a higher epoch, which
// answers `stale`), so the fence goes once more one epoch above: it lands, and a later move onto
// the edge re-mints above it as for any edge epoch (moveToEdge).
async function assignFence(
  admin: EdgeAdmin,
  fence: Identity & { cellId: string; assignmentEpoch: number }
): Promise<{ outcome: string; assignmentEpoch: number }> {
  const first = await admin.assign(fence)
  if (first.outcome !== 'conflict' || first.assignmentEpoch !== fence.assignmentEpoch) {
    return { outcome: first.outcome, assignmentEpoch: fence.assignmentEpoch }
  }
  const above = fence.assignmentEpoch + 1
  const second = await admin.assign({ ...fence, assignmentEpoch: above })
  console.warn(
    JSON.stringify({ event: 'orca_relay_edge_fence_above_conflict', outcome: second.outcome, assignmentEpoch: above })
  )
  return { outcome: second.outcome, assignmentEpoch: above }
}

// The fence right after a host left (EdgeAssignments.fenceAway). Anything but applied/unchanged
// fails: unavailable, `conflict`, or `stale` (the edge holds a newer epoch, so it still claims the
// host); the failure is logged and recorded for retry. Returns whether the fence landed.
export async function fenceEdge(
  database: RelayDatabase,
  admin: EdgeAdmin,
  fence: Identity & { cellId: string; assignmentEpoch: number },
  attempts: number,
  now: number
): Promise<boolean> {
  const { cellId, assignmentEpoch } = fence
  let outcome = 'unavailable'
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      outcome = (await assignFence(admin, fence)).outcome
    } catch (error) {
      if (!(error instanceof EdgeAdminUnavailableError)) { throw error }
      outcome = error.message
    }
    if (outcome === 'applied' || outcome === 'unchanged') { return true }
    // The same epoch stays stale; only a later move (a newer epoch) can land.
    if (outcome === 'stale') { break }
  }
  console.error(JSON.stringify({ event: 'orca_relay_edge_fence_failed', outcome, cellId, assignmentEpoch }))
  try {
    await recordPendingFence(database, fence, cellId, assignmentEpoch, now)
  } catch (error) {
    // Best effort, like the fence itself: the host is already placed and its answer still goes out.
    console.error(
      JSON.stringify({
        event: 'orca_relay_edge_fence_record_failed',
        reason: error instanceof Error ? error.message : 'unknown'
      })
    )
  }
  return false
}

type Retry = 'landed' | 'dropped' | 'failed'

// One pass over the due pending fences. Returns whether any pending fence is left (the sweep then
// keeps its busy cadence).
export async function retryPendingFences(
  database: RelayDatabase,
  admin: EdgeAdmin,
  edgeCellId: string,
  now: () => number
): Promise<boolean> {
  const due = await database.query(
    `SELECT user_id, relay_host_id, attempts, next_attempt_at FROM relay_edge_fence_pending
     WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`,
    [now(), EDGE_FENCE_RETRY_BATCH]
  )
  await forEachBounded(due, EDGE_FENCE_RETRY_CONCURRENCY, async (row) => {
    const identity = { userId: text(row, 'user_id'), relayHostId: text(row, 'relay_host_id') }
    const attempts = integer(row, 'attempts') + 1
    // Claim the attempt: a director that read the same row loses here and skips it.
    const claimed = await database.query(
      `UPDATE relay_edge_fence_pending SET attempts = ?, next_attempt_at = ?
       WHERE user_id = ? AND relay_host_id = ? AND attempts = ? AND next_attempt_at = ?
       RETURNING attempts`,
      [attempts, now() + edgeFenceRetryDelayMs(attempts), identity.userId, identity.relayHostId,
        attempts - 1, integer(row, 'next_attempt_at')]
    )
    if (claimed.length !== 1) { return }
    const result = await retryOne(database, admin, edgeCellId, identity, attempts)
    if (result !== 'failed' || attempts >= EDGE_FENCE_MAX_ATTEMPTS) {
      // Only the claimed record: a newer failure recorded meanwhile restarted at attempts = 0.
      await database.query(
        `DELETE FROM relay_edge_fence_pending WHERE user_id = ? AND relay_host_id = ? AND attempts = ?`,
        [identity.userId, identity.relayHostId, attempts]
      )
    }
  })
  return (await database.query(`SELECT attempts FROM relay_edge_fence_pending LIMIT 1`)).length > 0
}

// Fences the edge to the host's CURRENT row; a host that is back on the edge (or has no row) needs
// no fence, since its next move away fences again.
async function retryOne(
  database: RelayDatabase,
  admin: EdgeAdmin,
  edgeCellId: string,
  identity: Identity,
  attempts: number
): Promise<Retry> {
  const row = (
    await database.query(
      `SELECT cell_id, assignment_epoch FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
  )[0]
  if (!row || text(row, 'cell_id') === edgeCellId) { return 'dropped' }
  const cellId = text(row, 'cell_id')
  const assignmentEpoch = integer(row, 'assignment_epoch')
  let outcome: string
  try {
    outcome = (await assignFence(admin, { ...identity, cellId, assignmentEpoch })).outcome
  } catch (error) {
    if (!(error instanceof EdgeAdminUnavailableError)) { throw error }
    outcome = error.message
  }
  if (outcome === 'applied' || outcome === 'unchanged') {
    console.warn(JSON.stringify({ event: 'orca_relay_edge_fence_retried', outcome, cellId, assignmentEpoch, attempts }))
    return 'landed'
  }
  console.error(
    JSON.stringify({ event: 'orca_relay_edge_fence_failed', outcome, cellId, assignmentEpoch, attempts, retry: true })
  )
  if (attempts >= EDGE_FENCE_MAX_ATTEMPTS) {
    // The record is dropped: the edge keeps claiming the host until it moves again.
    console.error(JSON.stringify({ event: 'orca_relay_edge_fence_abandoned', outcome, cellId, assignmentEpoch, attempts }))
  }
  return 'failed'
}

// Runs `task` over `items` with at most `limit` in flight. A throw does not stop the other workers;
// the first one is rethrown once all have settled.
export async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      if (item !== undefined) { await task(item) }
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, async () => await worker())
  )
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed) { throw failed.reason instanceof Error ? failed.reason : new Error('relay_edge_task_failed') }
}
