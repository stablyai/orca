import { OrchestrationError } from '../../orchestration-error'
import type { TaskStatus } from '../orchestration-records'
import type { OrchestrationDb } from '../orchestration-db'

export type RemotePlacementRow = {
  task_id: string
  run_id: string
  environment_id: string
  conversation_id: string
  state: 'reserved' | 'accepted'
  request_key: string
  prior_task_status: TaskStatus
  dispatch_id: string | null
  created_at: string
  never_sent_at: string | null
  ambiguous_sent_at: string | null
}

// A start call waits at most three minutes. Leave ample time for a delayed server, then let an
// operator retire an unanswered reservation instead of permanently stranding the Task.
const AMBIGUOUS_REMOTE_START_RECOVERY_MINUTES = 15

/**
 * The Task's placement on a server, while its link is open. Under a closed link (a re-made
 * pairing) the server can never answer for it, so it holds nothing: not the Task, not its starts.
 */
export function getLiveRemotePlacement(
  db: OrchestrationDb,
  taskId: string
): RemotePlacementRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT placement.* over this table returns exactly its row shape.
  return db.db
    .prepare(
      `SELECT placement.* FROM remote_placements placement
       JOIN remote_run_links link
         ON link.conversation_id = placement.conversation_id AND link.state = 'open'
       WHERE placement.task_id = ?`
    )
    .get(taskId) as RemotePlacementRow | undefined
}

/** A start claimed the Task here: no attempt on a server speaks for it any more. */
export function retireRemotePlacement(db: OrchestrationDb, taskId: string): void {
  db.db.prepare('DELETE FROM remote_placements WHERE task_id = ?').run(taskId)
}

/**
 * Every send under the reservation's key failed before leaving this Orca. It stays reserved, so a
 * same-key retry resends, but a cancel of the Task may now retire it.
 */
export function markRemotePlacementNeverSent(
  db: OrchestrationDb,
  taskId: string,
  requestKey: string
): void {
  db.db
    .prepare(
      `UPDATE remote_placements SET never_sent_at = datetime('now')
       WHERE task_id = ? AND request_key = ? AND state = 'reserved'`
    )
    .run(taskId, requestKey)
}

/** The server may have accepted the start, but this Orca lost its answer. */
export function markRemotePlacementAmbiguous(
  db: OrchestrationDb,
  taskId: string,
  requestKey: string
): void {
  db.db
    .prepare(
      `UPDATE remote_placements SET ambiguous_sent_at = datetime('now')
       WHERE task_id = ? AND request_key = ? AND state = 'reserved'`
    )
    .run(taskId, requestKey)
}

/**
 * A cancel of the Task retires its reservation when no start for it can have reached the server:
 * no attempt there, and every send failed before leaving this Orca. Any other reservation may
 * stand for a Dispatch the server created, so it keeps holding the Task.
 */
export function retireNeverSentReservation(db: OrchestrationDb, taskId: string): void {
  db.db
    .prepare(
      `DELETE FROM remote_placements
       WHERE task_id = ? AND state = 'reserved'
         AND never_sent_at IS NOT NULL
         AND conversation_id IN (SELECT conversation_id FROM remote_run_links WHERE state = 'open')`
    )
    .run(taskId)
}

/**
 * An unanswered sent start has no Dispatch to stop. Once its recovery window has elapsed, an
 * explicit Task cancellation may retire the fence; retrying first with the original request key
 * remains the idempotent route to recover a late server receipt.
 */
export function retireExpiredAmbiguousReservation(db: OrchestrationDb, taskId: string): void {
  db.db
    .prepare(
      `DELETE FROM remote_placements
       WHERE task_id = ? AND state = 'reserved'
         AND never_sent_at IS NULL
         AND julianday(COALESCE(ambiguous_sent_at, created_at)) <= julianday('now', ?)
         AND conversation_id IN (SELECT conversation_id FROM remote_run_links WHERE state = 'open')`
    )
    .run(taskId, `-${AMBIGUOUS_REMOTE_START_RECOVERY_MINUTES} minutes`)
}

/**
 * A Task placed on this server through a link its re-made or removed pairing closed is still held
 * there under that link's Run, which this pairing cannot reach; the Task is not reused there.
 */
export function refuseTaskOfClosedPairing(
  db: OrchestrationDb,
  taskId: string,
  server: { peerFingerprint: string; name: string }
): void {
  const earlier = db.db
    .prepare(
      `SELECT 1 FROM remote_placements placement
       JOIN remote_run_links earlier ON earlier.conversation_id = placement.conversation_id
       WHERE placement.task_id = ? AND earlier.state = 'closed' AND earlier.peer_fingerprint = ?`
    )
    .get(taskId, server.peerFingerprint)
  if (earlier) {
    throw new OrchestrationError(
      'task_not_startable',
      `Task ${taskId} was placed through a pairing with ${server.name} that was re-made or removed; create a new task to run it there. No effects were applied.`,
      { taskId, effectsApplied: false }
    )
  }
}
