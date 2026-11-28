import type { WorkerTerminalResourceRow } from '../../terminal-authority/release/worker-terminal-ownership'
import type { OrchestrationDb } from '../orchestration-db'

/** Rows a release sweep could ever act on; kept in a partial index so legacy history is never read. */
export const UNRELEASED_MINTED_WORKER_TERMINAL_SQL = `release_state = 'not_requested'
  AND ownership_state = 'owned'
  AND process_incarnation LIKE '%:________-____-____-____-____________'
  AND terminal_handle NOT LIKE 'structworker\\_%' ESCAPE '\\'`

/**
 * One page of minted, never-requested terminal (not chat) worker rows, in owner order. `eligible` marks
 * the ones whose worker settled before `updatedBefore`: older builds left these owned, pinning their Run.
 */
export function listSettledWorkerTerminalsStillOwned(
  this: OrchestrationDb,
  afterOwnerDispatchId: string,
  limit: number,
  updatedBefore: string
): (WorkerTerminalResourceRow & { eligible: number })[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: res.* plus its eligibility.
  return this.db
    .prepare(
      // Pages on the partial index's own key, so each page reads at most `limit` entries; legacy fences
      // never enter the index.
      `SELECT res.*,
          (w.state IN ('succeeded', 'failed', 'stopped', 'abandoned') AND res.updated_at < ?) AS eligible
        FROM (
          SELECT * FROM worker_terminal_resources
            INDEXED BY idx_worker_terminal_resources_unreleased_minted
            WHERE ${UNRELEASED_MINTED_WORKER_TERMINAL_SQL} AND owner_dispatch_id > ?
            ORDER BY owner_dispatch_id LIMIT ?
        ) res
        LEFT JOIN worker_dispatches w ON w.dispatch_id = res.owner_dispatch_id
        ORDER BY res.owner_dispatch_id`
    )
    .all(updatedBefore, afterOwnerDispatchId, limit) as (WorkerTerminalResourceRow & {
    eligible: number
  })[]
}
