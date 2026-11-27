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
  // A chain shares one row, so read the pairs first and each distinct row once, not once per Dispatch.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both selected columns are NOT NULL TEXT keys of the prior-owner index.
  const pairs = this.db
    .prepare(
      `SELECT p.dispatch_id, p.resource_id FROM worker_terminal_resource_prior_owners p
         JOIN worker_terminal_resources r ON r.id = p.resource_id
        WHERE p.dispatch_id IN (${dispatchIds.map(() => '?').join(',')})
        ORDER BY r.updated_at ASC`
    )
    .all(...dispatchIds) as { dispatch_id: string; resource_id: string }[]
  const resourceIds = [...new Set(pairs.map((pair) => pair.resource_id))]
  if (resourceIds.length === 0) {
    return new Map()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: r.* is the resource row, as every other worker_terminal_resources read in db/.
  const rows = this.db
    .prepare(
      `SELECT r.* FROM worker_terminal_resources r
        WHERE r.id IN (${resourceIds.map(() => '?').join(',')})`
    )
    .all(...resourceIds) as WorkerTerminalResourceRow[]
  const rowById = new Map(rows.map((row) => [row.id, row]))
  const byDispatch = new Map<string, WorkerTerminalResourceRow>()
  for (const pair of pairs) {
    const row = rowById.get(pair.resource_id)
    if (row) {
      byDispatch.set(pair.dispatch_id, row)
    }
  }
  return byDispatch
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
