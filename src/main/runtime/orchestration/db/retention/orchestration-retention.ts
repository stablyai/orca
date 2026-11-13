import type { OrchestrationDb } from '../orchestration-db'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import { POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES } from '../federation/remote-attachment-liveness'
import { readRemovedWorkWatermark } from '../reset/removed-orchestration-work-read'

const LIVE_WORKER_STATES = POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES.map(
  (state) => `'${state}'`
).join(', ')

const recent = (column: string): string => `julianday(${column}) > julianday('now', ?1)`
const expired = (column: string): string => `julianday(${column}) <= julianday('now', ?1)`

// Bound coordinators and unread mail are left to the caller, which knows who is still live.
const RETIRED_RUN_SQL = `
  r.legacy = 0 AND r.home_database = 'this_database'
  AND ${expired('r.created_at')} AND ${expired('r.updated_at')}
  AND NOT EXISTS (SELECT 1 FROM peer_runs WHERE peer_runs.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM legacy_adoptions WHERE legacy_adoptions.adopted_run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM remote_run_links WHERE remote_run_links.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM remote_placements WHERE remote_placements.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM remote_dispatches WHERE remote_dispatches.run_id = r.id)
  AND NOT EXISTS (
    SELECT 1 FROM remote_owned_questions WHERE remote_owned_questions.run_id = r.id)
  AND NOT EXISTS (
    SELECT 1 FROM tasks t WHERE t.run_id = r.id
      AND (t.status IN ('pending', 'ready', 'dispatched', 'blocked')
        OR ${recent('t.created_at')} OR ${recent('t.completed_at')}))
  AND NOT EXISTS (
    SELECT 1 FROM dispatch_contexts d WHERE d.run_id = r.id
      AND (d.status IN ('pending', 'dispatched')
        OR ${recent('d.created_at')} OR ${recent('d.dispatched_at')}
        OR ${recent('d.completed_at')} OR ${recent('d.last_heartbeat_at')}
        OR EXISTS (
          SELECT 1 FROM worker_dispatches w WHERE w.dispatch_id = d.id
            AND (w.state IN (${LIVE_WORKER_STATES}) OR ${recent('w.updated_at')}))
        OR EXISTS (
          SELECT 1 FROM remote_dispatch_attachments a WHERE a.dispatch_id = d.id
            AND (a.state IN (${LIVE_WORKER_STATES}) OR ${recent('a.updated_at')}))
        OR EXISTS (
          SELECT 1 FROM worker_terminal_resources res WHERE res.owner_dispatch_id = d.id
            AND ((res.ownership_state IN ('owned', 'transferred') AND res.release_state <> 'released')
              OR ${recent('res.updated_at')}))
        OR EXISTS (
          SELECT 1 FROM worker_terminal_resources moved
          WHERE moved.origin_dispatch_id = d.id AND moved.owner_dispatch_id <> d.id)
        OR EXISTS (
          SELECT 1 FROM federated_dispatches f WHERE f.dispatch_id = d.id
            AND (f.home_auto_release_at IS NOT NULL OR ${recent('f.updated_at')}))
        OR EXISTS (
          SELECT 1 FROM remote_questions q WHERE q.dispatch_id = d.id AND q.status = 'pending')
        OR EXISTS (
          SELECT 1 FROM federation_relay_items i WHERE i.dispatch_id = d.id AND i.acked_at IS NULL)))
  AND NOT EXISTS (
    SELECT 1 FROM question_threads q WHERE q.run_id = r.id
      AND (q.status = 'pending' OR ${recent('q.created_at')} OR ${recent('q.answered_at')}
        OR ${recent('q.closed_at')}))
  AND NOT EXISTS (
    SELECT 1 FROM decision_gates g WHERE g.run_id = r.id
      AND (g.status = 'pending' OR ${recent('g.created_at')} OR ${recent('g.resolved_at')}))
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.run_id = r.id AND ${recent('m.created_at')})
  AND NOT EXISTS (
    SELECT 1 FROM deliveries v WHERE v.run_id = r.id
      AND (${recent('v.created_at')} OR ${recent('v.acknowledged_at')}))`

const DISPATCH_IDS = 'SELECT id FROM dispatch_contexts WHERE run_id = ?1'
const LEGACY_PRINCIPAL_IDS = 'SELECT id FROM legacy_compatibility_principals WHERE run_id = ?1'

// Dispatch-keyed rows go first, while each Dispatch still names its Run for removed-work capture.
const RUN_DELETES = [
  `DELETE FROM worker_terminal_archives WHERE dispatch_id IN (${DISPATCH_IDS})`,
  `DELETE FROM federation_relay_items WHERE dispatch_id IN (${DISPATCH_IDS})`,
  `DELETE FROM federation_relay_sequences WHERE dispatch_id IN (${DISPATCH_IDS})`,
  `DELETE FROM remote_questions WHERE dispatch_id IN (${DISPATCH_IDS})`,
  `DELETE FROM remote_dispatch_attachments WHERE dispatch_id IN (${DISPATCH_IDS})`,
  `DELETE FROM attempt_observation_facts WHERE dispatch_id IN (${DISPATCH_IDS})`,
  `DELETE FROM federated_dispatches WHERE dispatch_id IN (${DISPATCH_IDS})`,
  `DELETE FROM worker_terminal_resources WHERE owner_dispatch_id IN (${DISPATCH_IDS})`,
  `DELETE FROM worker_dispatches WHERE dispatch_id IN (${DISPATCH_IDS})`,
  `DELETE FROM message_dispatch_provenance WHERE dispatch_id IN (${DISPATCH_IDS})
     OR message_id IN (SELECT id FROM messages WHERE run_id = ?1)`,
  `DELETE FROM legacy_operation_receipts WHERE principal_id IN (${LEGACY_PRINCIPAL_IDS})`,
  `DELETE FROM legacy_mail_receipts WHERE principal_id IN (${LEGACY_PRINCIPAL_IDS})`,
  'DELETE FROM legacy_compatibility_principals WHERE run_id = ?1',
  'DELETE FROM question_threads WHERE run_id = ?1',
  'DELETE FROM decision_gates WHERE run_id = ?1',
  'DELETE FROM deliveries WHERE run_id = ?1',
  'DELETE FROM dispatch_contexts WHERE run_id = ?1',
  'DELETE FROM messages WHERE run_id = ?1',
  'DELETE FROM tasks WHERE run_id = ?1',
  'DELETE FROM runs WHERE id = ?1'
]

const dispatchGone = (column: string): string =>
  `NOT EXISTS (SELECT 1 FROM dispatch_contexts WHERE id = ${column})
   AND NOT EXISTS (SELECT 1 FROM remote_dispatch_attachments WHERE dispatch_id = ${column})`

const limited = (table: string, predicate: string): string =>
  `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${predicate} LIMIT ?2)`

// Relay cursors continue from their newest row and peer conversations dedupe on theirs: both stay.
const EXPIRED_ROW_DELETES = [
  limited(
    'federation_relay_items',
    `acked_at IS NOT NULL AND ${expired('acked_at')}
     AND EXISTS (
       SELECT 1 FROM federation_relay_items later
       WHERE later.dispatch_id = federation_relay_items.dispatch_id
         AND later.direction = federation_relay_items.direction
         AND later.sequence > federation_relay_items.sequence)
     AND NOT EXISTS (SELECT 1 FROM peer_runs WHERE conversation_id = federation_relay_items.dispatch_id)
     AND NOT EXISTS (
       SELECT 1 FROM peer_mail_conversations
       WHERE conversation_id = federation_relay_items.dispatch_id)`
  ),
  limited(
    'worker_terminal_archives',
    `${expired('created_at')} AND ${dispatchGone('worker_terminal_archives.dispatch_id')}`
  ),
  limited(
    'worker_terminal_resources',
    `${expired('updated_at')} AND release_state NOT IN ('requested', 'releasing')
     AND auto_release_at IS NULL
     AND ${dispatchGone('worker_terminal_resources.owner_dispatch_id')}
     AND ${dispatchGone('worker_terminal_resources.origin_dispatch_id')}`
  ),
  limited(
    'worker_dispatches',
    `${expired('updated_at')} AND state NOT IN (${LIVE_WORKER_STATES})
     AND ${dispatchGone('worker_dispatches.dispatch_id')}`
  ),
  limited(
    'removed_orchestration_work',
    `${expired('removed_at')} AND (run_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM runs WHERE id = removed_orchestration_work.run_id))`
  )
]

// Run-show reads removed work by Run, so a record left without one is never read.
function forgetUnownedRemovedWork(this: OrchestrationDb, watermark: number): void {
  this.db
    .prepare(
      `DELETE FROM removed_orchestration_work
       WHERE seq > ? AND (run_id IS NULL OR NOT EXISTS (SELECT 1 FROM runs WHERE id = run_id))`
    )
    .run(watermark)
}

const retentionAge = (retentionHours: number): string => `-${retentionHours} hours`

/** Retired Run ids after `afterRunId` in id order, so a sweep pages past Runs it had to keep. */
export function listRetiredRunCandidates(
  this: OrchestrationDb,
  retentionHours: number,
  afterRunId: string,
  limit: number
): string[] {
  return this.db
    .prepare(
      `SELECT r.id FROM runs r WHERE r.id > ?2 AND ${RETIRED_RUN_SQL} ORDER BY r.id LIMIT ?3`
    )
    .all(retentionAge(retentionHours), afterRunId, limit)
    .map((row) => String(row.id))
}

export type RunPartyLiveness = {
  isLiveHandle(handle: string): boolean
  isLivePane(paneKey: string): boolean
}

// A re-minted terminal keeps its pane, so every pane the Run's coordinators used counts too.
function runParties(this: OrchestrationDb, runId: string): string[] {
  return this.db
    .prepare(
      `SELECT 'handle' AS kind, 'run:' || ?1 AS party
       UNION SELECT 'handle', coordinator_handle FROM runs WHERE id = ?1
       UNION SELECT 'handle', terminal_handle FROM run_coordinator_handles WHERE run_id = ?1
       UNION SELECT 'handle', to_handle FROM messages
         WHERE run_id = ?1 AND read = 0 AND delivery_contract = 'current_delivery'
       UNION SELECT 'pane', coordinator_pane_key FROM runs WHERE id = ?1
       UNION SELECT 'pane', creator_pane_key FROM dispatch_contexts WHERE run_id = ?1
       UNION SELECT 'pane', created_by_pane_key FROM tasks WHERE run_id = ?1
       UNION SELECT 'pane', sender_pane_key FROM messages
         WHERE run_id = ?1 AND from_handle IN (
           SELECT terminal_handle FROM run_coordinator_handles WHERE run_id = ?1)`
    )
    .all(runId)
    .flatMap((row) => (row.party === null ? [] : [`${String(row.kind)}:${String(row.party)}`]))
}

function isLiveRunParty(party: string, liveness: RunPartyLiveness): boolean {
  return party.startsWith('pane:')
    ? liveness.isLivePane(party.slice('pane:'.length))
    : liveness.isLiveHandle(party.slice('handle:'.length))
}

/** A live bound coordinator or mail reader keeps the Run; liveness is read outside the lock. */
export function deleteRetiredRun(
  this: OrchestrationDb,
  runId: string,
  retentionHours: number,
  liveness: RunPartyLiveness
): boolean {
  const checkedParties = runParties.call(this, runId)
  if (checkedParties.some((party) => isLiveRunParty(party, liveness))) {
    return false
  }
  const deleted = runLifecycleWriteTransaction(this.db, 'orchestration_retention', () => {
    const retired = this.db
      .prepare(`SELECT 1 FROM runs r WHERE r.id = ?2 AND ${RETIRED_RUN_SQL}`)
      .get(retentionAge(retentionHours), runId)
    if (
      !retired ||
      runParties.call(this, runId).some((party) => !checkedParties.includes(party))
    ) {
      return false
    }
    const watermark = readRemovedWorkWatermark(this.db)
    for (const statement of RUN_DELETES) {
      this.db.prepare(statement).run(runId)
    }
    forgetUnownedRemovedWork.call(this, watermark)
    return true
  })
  if (deleted) {
    this.hasAnyDispatchContextsCache = undefined
  }
  return deleted
}

export function deleteExpiredOrchestrationRows(
  this: OrchestrationDb,
  retentionHours: number,
  limit: number
): number {
  return runLifecycleWriteTransaction(this.db, 'orchestration_retention', () => {
    const watermark = readRemovedWorkWatermark(this.db)
    const age = retentionAge(retentionHours)
    let deleted = 0
    for (const statement of EXPIRED_ROW_DELETES) {
      deleted += Number(this.db.prepare(statement).run(age, limit).changes)
    }
    forgetUnownedRemovedWork.call(this, watermark)
    return deleted
  })
}

export type OrchestrationRetentionMethods = {
  listRetiredRunCandidates: typeof listRetiredRunCandidates
  deleteRetiredRun: typeof deleteRetiredRun
  deleteExpiredOrchestrationRows: typeof deleteExpiredOrchestrationRows
}

export function attachOrchestrationRetention(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    listRetiredRunCandidates,
    deleteRetiredRun,
    deleteExpiredOrchestrationRows
  })
}
