import type Database from '../../../../sqlite/sync-database'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../shared/agent-session/identity/orca-session-address-prefix'
import { STRUCTURED_WORKER_HANDLE_PREFIX } from '../../../../../shared/orchestration/workers/structured-worker-handle'
import { structuredAgentSessionTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { STRUCTURED_WORKER_INCARNATION_PREFIX } from '../../terminal-authority/structured-sessions/structured-worker-incarnation'
import { orcaSessionIdOfAddressSql } from '../orca-session-address-sql'
import { currentRunCoordinatorSessionAddressSql } from './run-coordinator-orca-session'

const SESSION_ADDRESS_GLOB = `'${ORCA_SESSION_ADDRESS_PREFIX}*'`
export const STRUCTURED_WORKER_HANDLE_GLOB_SQL = `'${STRUCTURED_WORKER_HANDLE_PREFIX}*'`
const INCARNATION_GLOB = `'${STRUCTURED_WORKER_INCARNATION_PREFIX}*'`
const STRUCTURED_SESSION_TAB_PREFIX = structuredAgentSessionTabId('')

/**
 * Structured-worker proof in Dispatch and worker-resource tables, one indexed EXISTS per column
 * so SQLite probes each index instead of scanning `dispatch_contexts`.
 */
function structuredWorkerEvidenceSql(addressSql: string): string {
  const sessionId = orcaSessionIdOfAddressSql(addressSql)
  const incarnation = `'${STRUCTURED_WORKER_INCARNATION_PREFIX}' || ${sessionId}`
  // Unary + on assignee_handle keeps the planner on idx_dispatch_assignee_orca_session_id instead of the handle range index.
  return `(EXISTS (
    SELECT 1 FROM dispatch_contexts AS worker_dispatch
    WHERE worker_dispatch.process_incarnation GLOB ${INCARNATION_GLOB}
      AND worker_dispatch.process_incarnation = ${incarnation}
  ) OR EXISTS (
    SELECT 1 FROM dispatch_contexts AS worker_dispatch
    WHERE worker_dispatch.assignee_orca_session_id = ${sessionId}
      AND +worker_dispatch.assignee_handle GLOB ${STRUCTURED_WORKER_HANDLE_GLOB_SQL}
  ) OR EXISTS (
    SELECT 1 FROM dispatch_contexts AS worker_dispatch
    WHERE worker_dispatch.creator_orca_session_id = ${sessionId}
      AND worker_dispatch.creator_handle GLOB ${STRUCTURED_WORKER_HANDLE_GLOB_SQL}
  ) OR EXISTS (
    SELECT 1 FROM worker_terminal_resources AS worker_resource
    WHERE worker_resource.process_incarnation = ${incarnation}
      AND worker_resource.terminal_handle GLOB ${STRUCTURED_WORKER_HANDLE_GLOB_SQL}
  ))`
}

/**
 * A remembered `orca_session_id:` row names a structured worker, so it keeps routing after that
 * worker stops coordinating. Chats have no `structworker_` handle and no `structured:<id>` incarnation.
 * `is_structured_worker` records that link when the Run was created or bound before any Dispatch row existed.
 */
export function structuredWorkerSessionAddressSql(addressSql: string, runIdSql: string): string {
  return `(${structuredWorkerEvidenceSql(addressSql)} OR EXISTS (
    SELECT 1 FROM run_coordinator_handles AS worker_alias
    WHERE worker_alias.run_id = ${runIdSql}
      AND worker_alias.terminal_handle = ${addressSql}
      AND worker_alias.is_structured_worker = 1
  ))`
}

/** Whether `aliasRow` is a handle-less chat's session alias, not a terminal or structured worker. */
export function chatSessionAliasRowSql(aliasRow: string): string {
  const addressSql = `${aliasRow}.terminal_handle`
  return `(${addressSql} GLOB ${SESSION_ADDRESS_GLOB}
    AND ${aliasRow}.is_structured_worker = 0
    AND NOT ${structuredWorkerEvidenceSql(addressSql)})`
}

/**
 * A chat session address left behind by a pre-upgrade takeover or an older binary's rebind.
 * Derived from the rows, like a worker seat grab, so reads ignore it until the next open deletes it.
 */
export function staleChatCoordinatorAliasSql(aliasRow: string): string {
  const addressSql = `${aliasRow}.terminal_handle`
  return `(${chatSessionAliasRowSql(aliasRow)}
    AND NOT EXISTS (
      SELECT 1 FROM runs AS session_run
      WHERE session_run.id = ${aliasRow}.run_id
        AND ${currentRunCoordinatorSessionAddressSql('session_run')} = ${addressSql}
    ))`
}

/**
 * Proof that the `structworker_*` handle this Run remembers belongs to the session being stamped.
 * `proofSql` is correlated on `remembered_worker`.
 */
function rememberedStructuredWorkerProofSql(proofSql: string): string {
  return `EXISTS (
    SELECT 1 FROM run_coordinator_handles AS remembered_worker
    WHERE remembered_worker.run_id = run_coordinator_handles.run_id
      AND remembered_worker.terminal_handle GLOB ${STRUCTURED_WORKER_HANDLE_GLOB_SQL}
      AND (${proofSql})
  )`
}

/** A removed dispatch's JSON pairs one handle column with that worker's session id. */
function removedDispatchPairSql(
  handleKey: 'assigneeHandle' | 'creatorHandle',
  sessionKey: 'assigneeOrcaSessionId' | 'creatorOrcaSessionId',
  sessionIdSql: string
): string {
  // Unary `+` strips TEXT column affinity from `remembered_worker.terminal_handle` so SQLite
  // matches both keys of the no-affinity `json_extract(...)` expression index instead of scanning.
  return `EXISTS (
    SELECT 1 FROM removed_orchestration_work
    WHERE kind = 'dispatch'
      AND json_extract(record, '$.${handleKey}') = +remembered_worker.terminal_handle
      AND json_extract(record, '$.${sessionKey}') = ${sessionIdSql}
  )`
}

/** Backfill statement stamping pre-upgrade structured-worker session aliases from surviving proofs. */
export function coordinatorSessionAliasBackfillSql(): string {
  const sessionId = orcaSessionIdOfAddressSql('run_coordinator_handles.terminal_handle')
  const panePrefix = `'${STRUCTURED_SESSION_TAB_PREFIX}' || ${sessionId} || ':'`
  const incarnation = `'${STRUCTURED_WORKER_INCARNATION_PREFIX}' || ${sessionId}`
  const survivingProof = rememberedStructuredWorkerProofSql(`
    EXISTS (
      SELECT 1 FROM messages
      WHERE messages.from_handle = remembered_worker.terminal_handle
        AND messages.from_handle GLOB ${STRUCTURED_WORKER_HANDLE_GLOB_SQL}
        AND messages.sender_pane_key IS NOT NULL
        AND substr(messages.sender_pane_key, 1, length(${panePrefix})) = ${panePrefix}
    ) OR EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.created_by_terminal_handle = remembered_worker.terminal_handle
        AND tasks.created_by_terminal_handle GLOB ${STRUCTURED_WORKER_HANDLE_GLOB_SQL}
        AND tasks.created_by_process_incarnation = ${incarnation}
        AND tasks.created_by_process_incarnation GLOB ${INCARNATION_GLOB}
    ) OR ${removedDispatchPairSql('assigneeHandle', 'assigneeOrcaSessionId', sessionId)}
      OR ${removedDispatchPairSql('creatorHandle', 'creatorOrcaSessionId', sessionId)}`)
  return `UPDATE run_coordinator_handles
    SET is_structured_worker = 1
    WHERE is_structured_worker = 0
      AND terminal_handle GLOB ${SESSION_ADDRESS_GLOB}
      AND (
        EXISTS (
          SELECT 1 FROM runs
          WHERE runs.legacy = 0
            AND runs.coordinator_handle GLOB ${STRUCTURED_WORKER_HANDLE_GLOB_SQL}
            AND runs.coordinator_orca_session_id = ${sessionId}
            AND ${currentRunCoordinatorSessionAddressSql('runs')} = run_coordinator_handles.terminal_handle
        )
        OR ${structuredWorkerEvidenceSql('run_coordinator_handles.terminal_handle')}
        OR ${survivingProof}
      )`
}

/**
 * Index proofs and stamp pre-upgrade session aliases before pruning stale chat rows. A worker who
 * lost a Run before upgrade is proven by any active Run it still coordinates, its creation Dispatch
 * or resource row, or any message — a heartbeat included — sent under its `structworker_*` handle
 * with a pane key prefixed by `structured-agent-session-<id>:`. That message may sit on another Run.
 * The handle still has to be one this Run remembers, so the pane key identifies the session and the
 * handle identifies which Run it coordinated. The prefix compare is literal, so a session id cannot
 * act as a GLOB wildcard. `idx_messages_crew_from` omits heartbeats, so worker sends use
 * `idx_messages_structured_worker_sender_pane`.
 *
 * A surviving task pairs `created_by_terminal_handle` with `created_by_process_incarnation`. A
 * removed dispatch record pairs `assigneeHandle`/`assigneeOrcaSessionId` or
 * `creatorHandle`/`creatorOrcaSessionId`. `createTables` creates both tables, and migrate has added
 * the task columns, before this runs. Deliveries, mail sends, and pointer rows name a session id for
 * chats and workers alike, so they cannot mark one as a worker. Once every proof is gone, the
 * 3-column alias table cannot finish the link: `first_bound_at` is whole seconds, and a stale chat
 * can share that second with the worker handle. Guessing would keep the chat alias (#45666), so a
 * takeover with no surviving proof is pruned.
 */
export function installCoordinatorSessionAliasIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dispatch_structured_process_incarnation
      ON dispatch_contexts(process_incarnation)
      WHERE process_incarnation GLOB ${INCARNATION_GLOB};
    CREATE INDEX IF NOT EXISTS idx_messages_structured_worker_sender_pane
      ON messages(from_handle, sender_pane_key)
      WHERE from_handle GLOB ${STRUCTURED_WORKER_HANDLE_GLOB_SQL}
        AND sender_pane_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_structured_worker_creator
      ON tasks(created_by_terminal_handle, created_by_process_incarnation)
      WHERE created_by_terminal_handle GLOB ${STRUCTURED_WORKER_HANDLE_GLOB_SQL}
        AND created_by_process_incarnation GLOB ${INCARNATION_GLOB};
    CREATE INDEX IF NOT EXISTS idx_removed_dispatch_assignee_session
      ON removed_orchestration_work(
        json_extract(record, '$.assigneeHandle'),
        json_extract(record, '$.assigneeOrcaSessionId')
      )
      WHERE kind = 'dispatch';
    CREATE INDEX IF NOT EXISTS idx_removed_dispatch_creator_session
      ON removed_orchestration_work(
        json_extract(record, '$.creatorHandle'),
        json_extract(record, '$.creatorOrcaSessionId')
      )
      WHERE kind = 'dispatch';
    ${coordinatorSessionAliasBackfillSql()};
  `)
}

/** Drop chat aliases that no longer name the Run's coordinator. Worker addresses stay. */
export function pruneStaleChatCoordinatorAliases(db: Database.Database): void {
  db.prepare(
    `DELETE FROM run_coordinator_handles WHERE ${staleChatCoordinatorAliasSql('run_coordinator_handles')}`
  ).run()
}

/**
 * Forget one stale chat alias so the next remember starts `first_bound_sequence` at this binding.
 * A pre-upgrade row would otherwise let routing sweep earlier direct mail into the Run.
 */
export function dropStaleChatCoordinatorAlias(
  db: Database.Database,
  runId: string,
  address: string
): void {
  db.prepare(
    `DELETE FROM run_coordinator_handles
     WHERE run_id = ? AND terminal_handle = ?
       AND ${staleChatCoordinatorAliasSql('run_coordinator_handles')}`
  ).run(runId, address)
}
