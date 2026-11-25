import type { WorkerTerminalResourceRow } from '../../terminal-authority/release/worker-terminal-ownership'
import type { OrchestrationDbConnection } from '../orchestration-db'

/** The row each Dispatch last handed on, newest like formerlyOwnedResourceIdSql; history only, never custody. */
export function readFormerlyOwnedResources(
  this: OrchestrationDbConnection,
  dispatchIds: readonly string[]
): Map<string, WorkerTerminalResourceRow> {
  if (dispatchIds.length === 0) {
    return new Map()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: r.* is the resource row, as every other worker_terminal_resources read in db/.
  const rows = this.db
    .prepare(
      `SELECT p.dispatch_id AS former_owner_dispatch_id, r.* FROM worker_terminal_resource_prior_owners p
         JOIN worker_terminal_resources r ON r.id = p.resource_id
        WHERE p.dispatch_id IN (${dispatchIds.map(() => '?').join(',')})
        ORDER BY r.updated_at ASC`
    )
    .all(...dispatchIds) as (WorkerTerminalResourceRow & { former_owner_dispatch_id: string })[]
  return new Map(
    rows.map(({ former_owner_dispatch_id, ...row }) => [former_owner_dispatch_id, row])
  )
}

/** Each Dispatch's own terminal row. */
export function readOwnedResources(
  this: OrchestrationDbConnection,
  dispatchIds: readonly string[]
): Map<string, WorkerTerminalResourceRow> {
  if (dispatchIds.length === 0) {
    return new Map()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: r.* is the resource row, as every other worker_terminal_resources read in db/.
  const rows = this.db
    .prepare(
      `SELECT r.* FROM worker_terminal_resources r
         WHERE r.owner_dispatch_id IN (${dispatchIds.map(() => '?').join(',')})`
    )
    .all(...dispatchIds) as WorkerTerminalResourceRow[]
  return new Map(rows.map((row) => [row.owner_dispatch_id, row]))
}
