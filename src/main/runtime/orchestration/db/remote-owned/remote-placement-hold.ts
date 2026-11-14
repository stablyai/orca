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
}

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
