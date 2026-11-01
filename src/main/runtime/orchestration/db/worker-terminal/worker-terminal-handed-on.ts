import type { WorkerTerminalResourceRow } from '../../worker-terminal-ownership'
import type { OrchestrationDb } from '../orchestration-db'

/** One row per former owner of each terminal a follow-up took over, as `prior.value`; malformed history names none. */
export const WORKER_TERMINAL_PRIOR_OWNERS_SQL = `worker_terminal_resources p,
  json_each(CASE WHEN json_valid(p.prior_owner_dispatch_ids) THEN p.prior_owner_dispatch_ids ELSE '[]' END) prior`

/** Each listed Dispatch's own terminal, and the terminal a follow-up took over from it, as `transferred`. */
export function readListedWorkerTerminalResources(
  this: OrchestrationDb,
  dispatchIds: readonly string[]
): {
  owned: Map<string, WorkerTerminalResourceRow>
  handedOn: Map<string, WorkerTerminalResourceRow>
} {
  const owned = new Map<string, WorkerTerminalResourceRow>()
  const handedOn = new Map<string, WorkerTerminalResourceRow>()
  if (dispatchIds.length === 0) {
    return { owned, handedOn }
  }
  const idList = dispatchIds.map(() => '?').join(',')
  // Oldest first, so the latest hand-off wins.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape, plus the two tag columns.
  const rows = this.db
    .prepare(
      `SELECT r.*, r.owner_dispatch_id AS listed_dispatch_id, 0 AS handed_on
         FROM worker_terminal_resources r
        WHERE r.owner_dispatch_id IN (${idList})
       UNION ALL
       SELECT p.*, prior.value AS listed_dispatch_id, 1 AS handed_on
         FROM ${WORKER_TERMINAL_PRIOR_OWNERS_SQL}
        WHERE p.prior_owner_dispatch_ids != '[]' AND prior.value IN (${idList})
        ORDER BY updated_at ASC`
    )
    .all(...dispatchIds, ...dispatchIds) as (WorkerTerminalResourceRow & {
    listed_dispatch_id: string
    handed_on: number
  })[]
  for (const { listed_dispatch_id, handed_on, ...resource } of rows) {
    if (handed_on === 1) {
      handedOn.set(listed_dispatch_id, { ...resource, ownership_state: 'transferred' })
    } else {
      owned.set(listed_dispatch_id, resource)
    }
  }
  return { owned, handedOn }
}
