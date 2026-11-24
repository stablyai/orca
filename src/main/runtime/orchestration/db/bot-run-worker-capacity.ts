import type { OrchestrationDb } from './orchestration-db'
import { OrchestrationError } from '../orchestration-error'
import { ACTIVE_REMOTE_WORKERS_FOR_LINK_SQL } from './remote-owned/remote-worker-capacity'

const BOT_RUN_ACTIVE_WORKER_LIMIT = 8

/** Run inside the transaction that writes the local Dispatch or remote reservation. */
export function assertBotRunWorkerCapacity(db: OrchestrationDb, runId: string): void {
  const remote = db.db
    .prepare(
      `SELECT COALESCE(SUM(CASE
         WHEN link.state = 'cancel_owed' THEN COALESCE(link.cancel_owed_workers, ?)
         ELSE ${ACTIVE_REMOTE_WORKERS_FOR_LINK_SQL}
       END), 0) AS workers
       FROM remote_run_links link
       WHERE link.run_id = ? AND link.state IN ('open', 'cancel_owed')`
    )
    .get(BOT_RUN_ACTIVE_WORKER_LIMIT, runId)
  const remoteWorkers = typeof remote?.workers === 'number' ? remote.workers : 0
  const free = BOT_RUN_ACTIVE_WORKER_LIMIT - remoteWorkers
  const full =
    free <= 0 ||
    db.db
      .prepare(
        `SELECT 1 FROM dispatch_contexts dc
       JOIN worker_dispatches wd ON wd.dispatch_id = dc.id
       WHERE dc.run_id = ? AND wd.state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')
       LIMIT 1 OFFSET ?`
      )
      .get(runId, free - 1)
  if (full) {
    throw new OrchestrationError(
      'bot_run_worker_limit',
      `This Run already has ${BOT_RUN_ACTIVE_WORKER_LIMIT} active workers. Continue with an existing worker or wait for one to settle before starting another.`,
      { effectsApplied: false }
    )
  }
}
