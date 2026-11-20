import type Database from '../../../../sqlite/sync-database'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../shared/agent-session/identity/orca-session-address-prefix'
import { STRUCTURED_WORKER_HANDLE_PREFIX } from '../../../../../shared/orchestration/workers/structured-worker-handle'
import { STRUCTURED_WORKER_INCARNATION_PREFIX } from '../../terminal-authority/structured-sessions/structured-worker-incarnation'
import { orcaSessionIdOfAddressSql } from '../orca-session-address-sql'
import { currentRunCoordinatorSessionAddressSql } from './run-coordinator-orca-session'

const SESSION_ADDRESS_GLOB = `'${ORCA_SESSION_ADDRESS_PREFIX}*'`
export const STRUCTURED_WORKER_HANDLE_GLOB_SQL = `'${STRUCTURED_WORKER_HANDLE_PREFIX}*'`
const INCARNATION_GLOB = `'${STRUCTURED_WORKER_INCARNATION_PREFIX}*'`

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
 * Index structured worker incarnations on `dispatch_contexts` and stamp any pre-upgrade active
 * structured-worker session alias before pruning stale chat rows.
 */
export function installCoordinatorSessionAliasIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dispatch_structured_process_incarnation
      ON dispatch_contexts(process_incarnation)
      WHERE process_incarnation GLOB ${INCARNATION_GLOB};
    UPDATE run_coordinator_handles
    SET is_structured_worker = 1
    WHERE is_structured_worker = 0
      AND terminal_handle GLOB ${SESSION_ADDRESS_GLOB}
      AND EXISTS (
        SELECT 1 FROM runs
        WHERE runs.id = run_coordinator_handles.run_id
          AND runs.legacy = 0
          AND runs.coordinator_handle GLOB ${STRUCTURED_WORKER_HANDLE_GLOB_SQL}
          AND ${currentRunCoordinatorSessionAddressSql('runs')} = run_coordinator_handles.terminal_handle
      );
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
