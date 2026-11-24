import type { OrchestrationDb } from './orchestration-db'
import { OrchestrationError } from '../orchestration-error'
import { ABANDONED_HERE } from './remote-owned/remote-dispatch-records'

const BOT_RUN_ACTIVE_WORKER_LIMIT = 8

/** Run inside the transaction that writes the local Dispatch or remote reservation. */
export function assertBotRunWorkerCapacity(db: OrchestrationDb, runId: string): void {
  const full = db.db
    .prepare(
      `SELECT 1 FROM dispatch_contexts dc
       JOIN worker_dispatches wd ON wd.dispatch_id = dc.id
       WHERE dc.run_id = ? AND wd.state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')
       UNION ALL
       SELECT 1 FROM remote_run_links link
       JOIN remote_placements placement ON placement.conversation_id = link.conversation_id
       WHERE link.run_id = ? AND link.state = 'open' AND placement.state = 'reserved'
       UNION ALL
       SELECT 1 FROM remote_dispatches dispatch
       JOIN remote_run_links link ON link.conversation_id = dispatch.conversation_id
       WHERE dispatch.run_id = ? AND link.state = 'open' AND dispatch.task_settled_here <> ?
         AND (dispatch.worker_state NOT IN ('succeeded', 'failed', 'stopped', 'abandoned')
           OR (dispatch.worker_state IS NULL AND dispatch.status IN ('pending', 'dispatched')))
       LIMIT 1 OFFSET ?`
    )
    .get(runId, runId, runId, ABANDONED_HERE, BOT_RUN_ACTIVE_WORKER_LIMIT - 1)
  if (full) {
    throw new OrchestrationError(
      'bot_run_worker_limit',
      `This Run already has ${BOT_RUN_ACTIVE_WORKER_LIMIT} active workers. Continue with an existing worker or wait for one to settle before starting another.`,
      { effectsApplied: false }
    )
  }
}
