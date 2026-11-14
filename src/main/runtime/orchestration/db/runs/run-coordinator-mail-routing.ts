import type Database from '../../../../sqlite/sync-database'
import type { OrchestrationDb } from '../orchestration-db'
import { refreshSchemaObjects } from '../schema/schema-object-refresh'
import { currentRunCoordinatorSessionAddressSql } from './run-coordinator-orca-session'
import { orcaSessionAddressSql, orcaSessionIdOfAddressSql } from '../orca-session-address-sql'

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
  // One EXISTS per address form reads its assignee index; unary + keeps the stat-less planner off the Run index it ties with.
  const grabbedAs = (assigneeMatchSql: string) => `EXISTS (
    SELECT 1 FROM dispatch_contexts AS grab
    WHERE ${assigneeMatchSql}
      AND +grab.run_id = ${aliasRow}.run_id
      AND NOT (grab.creator_handle IS NOT NULL AND grab.creator_handle = grab.assignee_handle)
      AND julianday(grab.created_at) <= julianday(${aliasRow}.first_bound_at)
      AND (grab.status IN ('pending', 'dispatched')
        OR julianday(datetime(grab.completed_at)) > julianday(${aliasRow}.first_bound_at))
  )`
  return `(${grabbedAs(`grab.assignee_handle = ${aliasRow}.terminal_handle`)}
    OR ${grabbedAs(
      `grab.assignee_orca_session_id = ${orcaSessionIdOfAddressSql(`${aliasRow}.terminal_handle`)}`
    )})`
}

/** Whether `addressSql` is a coordinator address of the Run `runIdSql`, seat grabs excluded. */
function coordinatorAliasSql(runIdSql: string, addressSql: string): string {
  return `EXISTS (
    SELECT 1 FROM run_coordinator_handles AS alias
    WHERE alias.run_id = ${runIdSql} AND alias.terminal_handle = ${addressSql}
      AND NOT ${workerSeatGrabSql('alias')}
  )`
}

/** Whether routing would move direct row `messageSql`: alias OR active Dispatch, unlike the insert trigger's alias AND NOT Dispatch. */
export function runOwnsDirectMessageSql(messageSql: string): string {
  const runIdSql = `${messageSql}.run_id`
  const addressSql = `${messageSql}.to_handle`
  return `(EXISTS (SELECT 1 FROM runs WHERE runs.id = ${runIdSql} AND runs.legacy = 0)
    AND (${coordinatorAliasSql(runIdSql, addressSql)}
      OR ${activeDispatchOwnsAddressSql(runIdSql, addressSql)}))`
}

export function rememberRunCoordinatorHandle(
  this: OrchestrationDb,
  runId: string,
  terminalHandle: string
): void {
  const changed = this.db
    .prepare(
      `INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle) VALUES (?, ?)`
    )
    .run(runId, terminalHandle)
  if (changed.changes) {
    this.crewChanges.notify(new Set(['topology']))
  }
}

const CURRENT_COORDINATOR_SESSION_ADDRESS_SQL = currentRunCoordinatorSessionAddressSql('runs')
const NEW_COORDINATOR_SESSION_ADDRESS_SQL = currentRunCoordinatorSessionAddressSql('NEW')

/** Cache both coordinator addresses; rebuild triggers on open when their SQL changed, after migration supplies session-id columns. */
export function createRunCoordinatorAddressTriggers(db: Database.Database): void {
  refreshSchemaObjects(db, [
    `CREATE TRIGGER trg_runs_remember_coordinator_insert
      AFTER INSERT ON runs
      WHEN NEW.legacy = 0
      BEGIN
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        SELECT NEW.id, NEW.coordinator_handle WHERE NEW.coordinator_handle IS NOT NULL;
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        SELECT NEW.id, ${NEW_COORDINATOR_SESSION_ADDRESS_SQL}
        WHERE ${NEW_COORDINATOR_SESSION_ADDRESS_SQL} IS NOT NULL;
      END;`,
    `CREATE TRIGGER trg_runs_remember_coordinator_update
      AFTER UPDATE OF coordinator_handle, coordinator_orca_session_id,
        coordinator_orca_session_id_generation ON runs
      WHEN NEW.legacy = 0
      BEGIN
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        SELECT NEW.id, NEW.coordinator_handle WHERE NEW.coordinator_handle IS NOT NULL;
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        SELECT NEW.id, ${NEW_COORDINATOR_SESSION_ADDRESS_SQL}
        WHERE ${NEW_COORDINATOR_SESSION_ADDRESS_SQL} IS NOT NULL;
      END;`
  ])
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
  refreshSchemaObjects(this.db, [
    `CREATE TRIGGER trg_messages_route_coordinator_mail
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
      END;`
  ])
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
  createCoordinatorMailRoutingTrigger: typeof createCoordinatorMailRoutingTrigger
  routeAllUnreadDirectMessagesToRunMailbox: typeof routeAllUnreadDirectMessagesToRunMailbox
}

export function attachRunCoordinatorMailRouting(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    rememberRunCoordinatorHandle,
    rememberCurrentRunCoordinatorHandles,
    createCoordinatorMailRoutingTrigger,
    routeAllUnreadDirectMessagesToRunMailbox
  })
}
