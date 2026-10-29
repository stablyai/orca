import type Database from '../../../../sqlite/sync-database'
import type { OrchestrationDb } from '../orchestration-db'
import { currentRunCoordinatorSessionAddressSql } from './run-coordinator-orca-session'
import { orcaSessionAddressSql } from '../orca-session-address-sql'

/** Mail to an active Dispatch assignee's address in the same Run is that worker's, not coordinator mail. */
export function activeDispatchOwnsAddressSql(runIdSql: string, addressSql: string): string {
  return `EXISTS (
    SELECT 1 FROM dispatch_contexts
    WHERE dispatch_contexts.run_id = ${runIdSql}
      AND (dispatch_contexts.assignee_handle = ${addressSql}
        OR ${orcaSessionAddressSql('dispatch_contexts.assignee_orca_session_id')} = ${addressSql})
      AND dispatch_contexts.status IN ('pending', 'dispatched')
  )`
}

/**
 * A remembered address first bound while it worked an unsettled, delegated Dispatch in the same Run
 * was a worker grabbing the seat, not a spelling of the coordinator, so it never routes as one.
 * Derived from the rows, so addresses older builds remembered stop mattering without editing them.
 * julianday() because completed_at is stored in two text formats; whole seconds and a strict >
 * because first_bound_at has no milliseconds, so a bind in the second a Dispatch settled is not a grab.
 */
export function workerSeatGrabSql(aliasRow: string): string {
  return `EXISTS (
    SELECT 1 FROM dispatch_contexts AS grab
    WHERE grab.run_id = ${aliasRow}.run_id
      AND (grab.assignee_handle = ${aliasRow}.terminal_handle
        OR ${orcaSessionAddressSql('grab.assignee_orca_session_id')} = ${aliasRow}.terminal_handle)
      AND NOT (grab.creator_handle IS NOT NULL AND grab.creator_handle = grab.assignee_handle)
      AND julianday(grab.created_at) <= julianday(${aliasRow}.first_bound_at)
      AND (grab.status IN ('pending', 'dispatched')
        OR julianday(datetime(grab.completed_at)) > julianday(${aliasRow}.first_bound_at))
  )`
}

/** Whether `addressSql` is a coordinator address of the Run `runIdSql`, seat grabs excluded. */
function coordinatorAliasSql(runIdSql: string, addressSql: string): string {
  return `EXISTS (
    SELECT 1 FROM run_coordinator_handles AS alias
    WHERE alias.run_id = ${runIdSql} AND alias.terminal_handle = ${addressSql}
      AND NOT ${workerSeatGrabSql('alias')}
  )`
}

export function rememberRunCoordinatorHandle(
  this: OrchestrationDb,
  runId: string,
  terminalHandle: string
): void {
  this.db
    .prepare(
      `INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle) VALUES (?, ?)`
    )
    .run(runId, terminalHandle)
}

/**
 * Drops this handle's stale cache rows so a synthetic coordinator with no pane/session
 * identity (where unbindOtherRunsForCoordinator matches nothing) still resolves to exactly
 * one mailbox — the run it just opened. Rows are a routing cache; the runs table is untouched.
 */
export function forgetRunCoordinatorHandlesExcept(
  this: OrchestrationDb,
  terminalHandle: string,
  keepRunId: string
): void {
  this.db
    .prepare(`DELETE FROM run_coordinator_handles WHERE terminal_handle = ? AND run_id != ?`)
    .run(terminalHandle, keepRunId)
}

const CURRENT_COORDINATOR_SESSION_ADDRESS_SQL = currentRunCoordinatorSessionAddressSql('runs')
const NEW_COORDINATOR_SESSION_ADDRESS_SQL = currentRunCoordinatorSessionAddressSql('NEW')

/** Cache both coordinator addresses; rebuild triggers on open for prefix skew, after migration supplies session-id columns. */
export function createRunCoordinatorAddressTriggers(db: Database.Database): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_runs_remember_coordinator_insert;
      DROP TRIGGER IF EXISTS trg_runs_remember_coordinator_update;
      CREATE TRIGGER trg_runs_remember_coordinator_insert
      AFTER INSERT ON runs
      WHEN NEW.legacy = 0
      BEGIN
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        SELECT NEW.id, NEW.coordinator_handle WHERE NEW.coordinator_handle IS NOT NULL;
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        SELECT NEW.id, ${NEW_COORDINATOR_SESSION_ADDRESS_SQL}
        WHERE ${NEW_COORDINATOR_SESSION_ADDRESS_SQL} IS NOT NULL;
      END;
      CREATE TRIGGER trg_runs_remember_coordinator_update
      AFTER UPDATE OF coordinator_handle, coordinator_orca_session_id,
        coordinator_orca_session_id_generation ON runs
      WHEN NEW.legacy = 0
      BEGIN
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        SELECT NEW.id, NEW.coordinator_handle WHERE NEW.coordinator_handle IS NOT NULL;
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        SELECT NEW.id, ${NEW_COORDINATOR_SESSION_ADDRESS_SQL}
        WHERE ${NEW_COORDINATOR_SESSION_ADDRESS_SQL} IS NOT NULL;
      END;
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// Every address the coordinator has, its handle and its session address, as the triggers above.
export function rememberCurrentRunCoordinatorHandles(this: OrchestrationDb): void {
  this.db.exec(`
    INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
    SELECT id, coordinator_handle FROM runs
    WHERE legacy = 0 AND coordinator_handle IS NOT NULL;
    INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
    SELECT id, ${CURRENT_COORDINATOR_SESSION_ADDRESS_SQL} FROM runs
    WHERE legacy = 0 AND ${CURRENT_COORDINATOR_SESSION_ADDRESS_SQL} IS NOT NULL;
  `)
}

export function createCoordinatorMailRoutingTrigger(this: OrchestrationDb): void {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.db.exec(`
      DROP TRIGGER IF EXISTS trg_messages_route_coordinator_mail;
      CREATE TRIGGER trg_messages_route_coordinator_mail
      AFTER INSERT ON messages
      WHEN NEW.read = 0 AND NEW.delivery_contract = 'current_delivery'
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE runs.id = NEW.run_id AND runs.legacy = 0
        )
        AND ${coordinatorAliasSql('NEW.run_id', 'NEW.to_handle')}
        AND NOT ${activeDispatchOwnsAddressSql('NEW.run_id', 'NEW.to_handle')}
      BEGIN
        UPDATE messages SET to_handle = 'run:' || NEW.run_id WHERE sequence = NEW.sequence;
      END;
    `)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function routeAllUnreadDirectMessagesToRunMailbox(
  this: OrchestrationDb,
  runId: string,
  directHandle: string
): void {
  this.db
    .prepare(
      `UPDATE messages SET to_handle = ?
       WHERE run_id = ? AND to_handle = ? AND read = 0
         AND delivery_contract = 'current_delivery'
         AND NOT ${activeDispatchOwnsAddressSql('messages.run_id', 'messages.to_handle')}
         AND NOT EXISTS (
           SELECT 1 FROM run_coordinator_handles AS alias
           WHERE alias.run_id = messages.run_id AND alias.terminal_handle = messages.to_handle
             AND ${workerSeatGrabSql('alias')}
         )`
    )
    .run(`run:${runId}`, runId, directHandle)
}

export type RunCoordinatorMailRoutingMethods = {
  rememberRunCoordinatorHandle: typeof rememberRunCoordinatorHandle
  rememberCurrentRunCoordinatorHandles: typeof rememberCurrentRunCoordinatorHandles
  forgetRunCoordinatorHandlesExcept: typeof forgetRunCoordinatorHandlesExcept
  createCoordinatorMailRoutingTrigger: typeof createCoordinatorMailRoutingTrigger
  routeAllUnreadDirectMessagesToRunMailbox: typeof routeAllUnreadDirectMessagesToRunMailbox
}

export function attachRunCoordinatorMailRouting(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    rememberRunCoordinatorHandle,
    rememberCurrentRunCoordinatorHandles,
    forgetRunCoordinatorHandlesExcept,
    createCoordinatorMailRoutingTrigger,
    routeAllUnreadDirectMessagesToRunMailbox
  })
}
