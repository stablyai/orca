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
         AND to_handle = ?
         AND EXISTS(
           SELECT 1 FROM dispatch_contexts d
           WHERE d.run_id = messages.run_id
             AND d.contract_version = ?
             AND (
               messages.from_handle = d.assignee_handle OR
               messages.from_handle = 'dispatch:' || d.id
             )
         )
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
             AND EXISTS(
               SELECT 1 FROM dispatch_contexts d
               WHERE d.run_id = messages.run_id
                 AND d.contract_version = ?
                 AND d.status IN ('pending', 'dispatched')
                 AND messages.created_at >= d.created_at
                 AND (
                   messages.from_handle = d.assignee_handle OR
                   messages.from_handle = 'dispatch:' || d.id
                 )
             )
           )
         )`
    )
    .run(
      `run:${runId}`,
      runId,
      retainedCoordinatorHandle,
      LEGACY_CONTRACT_VERSION,
      retainedCoordinatorHandle,
      LEGACY_CONTRACT_VERSION
    )
}

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
  const durableRows = this.db
    .prepare(
      `SELECT coordinator_handle AS handle
       FROM coordinator_runs
       WHERE scheduler_lost_at = ?
       UNION
       SELECT created_by_terminal_handle AS handle
       FROM tasks t
       WHERE t.run_id = ? AND t.created_by_terminal_handle IS NOT NULL
         AND t.created_at <= ?
         AND EXISTS(
           SELECT 1 FROM dispatch_contexts d
           WHERE d.task_id = t.id AND d.run_id = t.run_id
         )`
    )
    .all(adoption.adopted_at, runId, adoption.adopted_at) as {
    handle: string
  }[]
  if (durableRows.some((row) => workerHandles.has(row.handle))) {
    return null
  }
  const candidates = new Set(durableRows.map((row) => row.handle))
  const mailRows = this.db
    .prepare(
      `SELECT m.to_handle AS handle
       FROM messages m
       INNER JOIN dispatch_contexts d
         ON d.run_id = m.run_id AND d.contract_version = ?
        AND (m.from_handle = d.assignee_handle OR m.from_handle = 'dispatch:' || d.id)
       WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct'
         AND m.created_at <= ?
       UNION
       SELECT m.from_handle AS handle
       FROM messages m
       INNER JOIN dispatch_contexts d
         ON d.run_id = m.run_id AND d.contract_version = ?
        AND (m.to_handle = d.assignee_handle OR m.to_handle = 'dispatch:' || d.id)
       WHERE m.run_id = ? AND m.delivery_contract = 'legacy_direct'
         AND m.created_at <= ?`
    )
    .all(
      LEGACY_CONTRACT_VERSION,
      runId,
      adoption.adopted_at,
      LEGACY_CONTRACT_VERSION,
      runId,
      adoption.adopted_at
    ) as {
    handle: string
  }[]
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
