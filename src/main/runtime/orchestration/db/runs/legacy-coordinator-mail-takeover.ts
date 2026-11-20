import { LEGACY_CONTRACT_VERSION } from '../contract-constants'
import type { OrchestrationDb } from '../orchestration-db'

export function promoteLegacyCoordinatorMailForTakeover(
  this: OrchestrationDb,
  runId: string,
  retainedCoordinatorHandle: string | null
): void {
  if (!retainedCoordinatorHandle) {
    return
  }
  this.db
    .prepare(
      `UPDATE messages
       SET to_handle = ?, delivery_contract = 'current_delivery',
           read = 0, delivered_at = NULL
       WHERE run_id = ? AND delivery_contract = 'legacy_direct'
         AND to_handle = ? AND type <> 'heartbeat'
         AND ${legacyDispatchAddressSql('messages.from_handle', 'messages.run_id')}
         AND (
           read = 0 OR EXISTS(
             SELECT 1 FROM question_threads q
             WHERE q.message_id = messages.id AND q.status = 'pending'
           ) OR EXISTS(
             SELECT 1
             FROM legacy_mail_receipts r
             INNER JOIN legacy_compatibility_principals p
               ON p.id = r.principal_id
             WHERE r.message_id = messages.id
               AND r.acknowledged_at IS NULL
               AND p.run_id = messages.run_id
               AND p.role = 'coordinator'
               AND p.terminal_handle = ?
           ) OR (
             read = 1
             AND NOT EXISTS(
               SELECT 1 FROM legacy_compatibility_principals p
               WHERE p.run_id = messages.run_id AND p.role = 'coordinator'
             )
             AND ${legacyDispatchAddressSql(
               'messages.from_handle',
               'messages.run_id',
               "AND d.status IN ('pending', 'dispatched') AND messages.created_at >= d.created_at"
             )}
           )
         )`
    )
    .run(`run:${runId}`, runId, retainedCoordinatorHandle, retainedCoordinatorHandle)
}

/** Whether `handle` addresses a legacy Dispatch of `runId`, by its assignee or as `dispatch:<id>`.
 *  Each arm is an index probe; one ORed join condition would scan every Dispatch in the Run per message. */
function legacyDispatchAddressSql(handle: string, runId: string, extra = ''): string {
  return `(EXISTS(
      SELECT 1 FROM dispatch_contexts d
      WHERE d.assignee_handle = ${handle} AND d.run_id = ${runId}
        AND d.contract_version = ${LEGACY_CONTRACT_VERSION} ${extra}
    ) OR (substr(${handle}, 1, 9) = 'dispatch:' AND EXISTS(
      SELECT 1 FROM dispatch_contexts d
      WHERE d.id = substr(${handle}, 10) AND ${handle} = 'dispatch:' || d.id
        AND d.run_id = ${runId}
        AND d.contract_version = ${LEGACY_CONTRACT_VERSION} ${extra}
    )))`
}

// Unary + keeps run_id out of the index choice: probing by run_id scans every Dispatch in the run per task.
export const LEGACY_COORDINATOR_DURABLE_HANDLES_SQL = `SELECT coordinator_handle AS handle
       FROM coordinator_runs
       WHERE scheduler_lost_at = ?
       UNION
       SELECT created_by_terminal_handle AS handle
       FROM tasks t
       WHERE t.run_id = ? AND t.created_by_terminal_handle IS NOT NULL
         AND t.created_at <= ?
         AND EXISTS(
           SELECT 1 FROM dispatch_contexts d
           WHERE d.task_id = t.id AND +d.run_id = t.run_id
         )`

// The other end of legacy mail a legacy Dispatch sent or received before adoption; each distinct pair is probed once.
export const LEGACY_COORDINATOR_MAIL_HANDLES_SQL = `WITH pairs AS (
         SELECT DISTINCT run_id, from_handle, to_handle
         FROM messages
         WHERE run_id = ? AND delivery_contract = 'legacy_direct' AND created_at <= ?
       )
       SELECT p.to_handle AS handle FROM pairs p
       WHERE ${legacyDispatchAddressSql('p.from_handle', 'p.run_id')}
       UNION
       SELECT p.from_handle AS handle FROM pairs p
       WHERE ${legacyDispatchAddressSql('p.to_handle', 'p.run_id')}`

export function getUniqueLegacyCoordinatorHandle(
  this: OrchestrationDb,
  runId: string
): string | null {
  const adoption = this.getLegacyAdoption()
  if (!adoption || adoption.adopted_run_id !== runId) {
    return null
  }
  const workerHandles = new Set(
    (
      this.db
        .prepare(
          `SELECT DISTINCT assignee_handle AS handle
           FROM dispatch_contexts
           WHERE run_id = ? AND assignee_handle IS NOT NULL
           UNION
           SELECT DISTINCT terminal_handle AS handle
           FROM legacy_compatibility_principals
           WHERE run_id = ? AND role = 'worker'
             AND status IN ('committed', 'settled')`
        )
        .all(runId, runId) as { handle: string }[]
    ).map((row) => row.handle)
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both UNION branches select one non-null TEXT column aliased handle.
  const durableRows = this.db
    .prepare(LEGACY_COORDINATOR_DURABLE_HANDLES_SQL)
    .all(adoption.adopted_at, runId, adoption.adopted_at) as {
    handle: string
  }[]
  if (durableRows.some((row) => workerHandles.has(row.handle))) {
    return null
  }
  const candidates = new Set(durableRows.map((row) => row.handle))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both UNION branches select one non-null TEXT column aliased handle.
  const mailRows = this.db
    .prepare(LEGACY_COORDINATOR_MAIL_HANDLES_SQL)
    .all(runId, adoption.adopted_at) as { handle: string }[]
  for (const row of mailRows) {
    if (
      !workerHandles.has(row.handle) &&
      !row.handle.startsWith('dispatch:') &&
      !row.handle.startsWith('run:')
    ) {
      candidates.add(row.handle)
    }
  }
  return candidates.size === 1 ? ([...candidates][0] ?? null) : null
}

export type LegacyCoordinatorMailTakeoverMethods = {
  promoteLegacyCoordinatorMailForTakeover: typeof promoteLegacyCoordinatorMailForTakeover
  getUniqueLegacyCoordinatorHandle: typeof getUniqueLegacyCoordinatorHandle
}

export function attachLegacyCoordinatorMailTakeover(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    promoteLegacyCoordinatorMailForTakeover,
    getUniqueLegacyCoordinatorHandle
  })
}
