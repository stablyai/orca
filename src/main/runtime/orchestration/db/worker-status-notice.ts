import type Database from '../../../sqlite/sync-database'

const NOTICE_FUNCTION = 'orca_worker_status_changed'

/** What a write did to a Dispatch's rows: a new Dispatch, a change to one, or a removal. */
export type DispatchRowChange = 'inserted' | 'written' | 'deleted'

/**
 * Calls `notice` with the Dispatch's id on every write to it, its worker, its terminal resource or its
 * Task, and on their removal (a reset deletes them all), whichever writer made it, so a reader of
 * worker rows hears of a settlement no agent phase change announced. The reader decides whether what it
 * shows changed. Any UPDATE fires, not a column list: TEMP triggers that named columns would stop a
 * migration on this connection from dropping one. TEMP triggers live on this connection only and leave
 * the file's schema alone. A rolled-back change still calls it.
 */
export function installWorkerStatusNotice(
  db: Database.Database,
  notice: (dispatchId: string | null, change: DispatchRowChange) => void
): void {
  db.function(NOTICE_FUNCTION, (dispatchId: unknown, change: unknown) => {
    try {
      notice(
        typeof dispatchId === 'string' ? dispatchId : null,
        change === 'inserted' || change === 'deleted' ? change : 'written'
      )
    } catch (error) {
      // A throw here would fail the write that fired it.
      console.warn('[orchestration] worker status notice failed', error)
    }
    return null
  })
  db.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS orca_dispatch_insert_notice
    AFTER INSERT ON main.dispatch_contexts
    BEGIN SELECT ${NOTICE_FUNCTION}(NEW.id, 'inserted'); END;
    CREATE TEMP TRIGGER IF NOT EXISTS orca_dispatch_update_notice
    AFTER UPDATE ON main.dispatch_contexts
    BEGIN SELECT ${NOTICE_FUNCTION}(NEW.id, 'written'); END;
    CREATE TEMP TRIGGER IF NOT EXISTS orca_dispatch_delete_notice
    AFTER DELETE ON main.dispatch_contexts
    BEGIN SELECT ${NOTICE_FUNCTION}(OLD.id, 'deleted'); END;
    CREATE TEMP TRIGGER IF NOT EXISTS orca_worker_insert_notice
    AFTER INSERT ON main.worker_dispatches
    BEGIN SELECT ${NOTICE_FUNCTION}(NEW.dispatch_id, 'written'); END;
    CREATE TEMP TRIGGER IF NOT EXISTS orca_worker_update_notice
    AFTER UPDATE ON main.worker_dispatches
    BEGIN SELECT ${NOTICE_FUNCTION}(NEW.dispatch_id, 'written'); END;
    CREATE TEMP TRIGGER IF NOT EXISTS orca_worker_delete_notice
    AFTER DELETE ON main.worker_dispatches
    BEGIN SELECT ${NOTICE_FUNCTION}(OLD.dispatch_id, 'deleted'); END;
    CREATE TEMP TRIGGER IF NOT EXISTS orca_worker_resource_insert_notice
    AFTER INSERT ON main.worker_terminal_resources
    BEGIN SELECT ${NOTICE_FUNCTION}(NEW.owner_dispatch_id, 'written'); END;
    CREATE TEMP TRIGGER IF NOT EXISTS orca_worker_resource_update_notice
    AFTER UPDATE ON main.worker_terminal_resources
    BEGIN
      SELECT ${NOTICE_FUNCTION}(OLD.owner_dispatch_id, 'written')
        WHERE OLD.owner_dispatch_id IS NOT NEW.owner_dispatch_id;
      SELECT ${NOTICE_FUNCTION}(NEW.owner_dispatch_id, 'written');
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS orca_worker_resource_delete_notice
    AFTER DELETE ON main.worker_terminal_resources
    BEGIN SELECT ${NOTICE_FUNCTION}(OLD.owner_dispatch_id, 'deleted'); END;
    CREATE TEMP TRIGGER IF NOT EXISTS orca_task_update_notice
    AFTER UPDATE ON main.tasks
    BEGIN SELECT ${NOTICE_FUNCTION}(d.id, 'written') FROM main.dispatch_contexts d WHERE d.task_id = NEW.id; END;
  `)
}
