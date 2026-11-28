import type { OrchestrationDb } from '../../db/orchestration-db'
import type { WorkerTurnStop, WorkerTurnStopDispatch } from './worker-turn-stop-report'

const FINISHED_STOP_COOLDOWN = '-600 seconds'

/** A clean finish whose worker's latest stop report, within the cooldown, was also a clean finish:
 *  its coordinator already knows it rests. A different stop since (an error, a prompt) resets it. */
export function finishedStopReportedRecently(
  db: OrchestrationDb,
  target: WorkerTurnStopDispatch,
  rest: Pick<WorkerTurnStop, 'reason'> & Partial<Pick<WorkerTurnStop, 'requestError'>>
): boolean {
  if (rest.reason !== 'finished' || rest.requestError) {
    return false
  }
  const row =
    target.kind === 'local'
      ? db.db
          .prepare(
            `SELECT CASE WHEN json_valid(payload) THEN json_extract(payload, '$.stopReason') END AS reason,
                    created_at >= datetime('now', ?) AS recent
               FROM messages
              WHERE id IN (SELECT message_id FROM message_dispatch_provenance WHERE dispatch_id = ?)
                AND (id LIKE 'msg_rest_%' OR id LIKE 'msg_stop_%')
              ORDER BY sequence DESC LIMIT 1`
          )
          .get(FINISHED_STOP_COOLDOWN, target.dispatch.id)
      : db.db
          .prepare(
            // A relayed report carries the worker's payload as a string inside its own.
            `SELECT CASE WHEN json_valid(payload) AND json_valid(json_extract(payload, '$.payload'))
                         THEN json_extract(json_extract(payload, '$.payload'), '$.stopReason') END AS reason,
                    created_at >= datetime('now', ?) AS recent
               FROM federation_relay_items
              WHERE dispatch_id = ? AND direction = 'to_home'
                AND (message_id LIKE 'msg_rest_%' OR message_id LIKE 'msg_stop_%')
              ORDER BY sequence DESC LIMIT 1`
          )
          .get(FINISHED_STOP_COOLDOWN, target.attachment.dispatch_id)
  return row?.recent === 1 && row.reason === 'finished'
}
