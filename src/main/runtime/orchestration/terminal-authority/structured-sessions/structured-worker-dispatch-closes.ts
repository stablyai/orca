// Structured workers whose Dispatch work ended, recorded by the database as it happens, so an
// orchestration change names them and a change elsewhere costs nothing per waiting chat.

import type { OrchestrationDb } from '../../db/orchestration-db'
import { STRUCTURED_WORKER_INCARNATION_PREFIX } from './structured-worker-identity'

const OPEN = "('pending', 'dispatched')"
const WORKER = `LIKE '${STRUCTURED_WORKER_INCARNATION_PREFIX}%'`

// Temporary: they live with this connection only and record nothing until someone watches.
const WATCH = `
CREATE TEMP TABLE IF NOT EXISTS structured_worker_dispatch_ends (process_incarnation TEXT NOT NULL);
CREATE TEMP TRIGGER IF NOT EXISTS structured_worker_dispatch_closed
  AFTER UPDATE OF status ON main.dispatch_contexts
  WHEN OLD.status IN ${OPEN} AND NEW.status NOT IN ${OPEN} AND OLD.process_incarnation ${WORKER}
  BEGIN INSERT INTO structured_worker_dispatch_ends VALUES (OLD.process_incarnation); END;
CREATE TEMP TRIGGER IF NOT EXISTS structured_worker_dispatch_reassigned
  AFTER UPDATE OF process_incarnation ON main.dispatch_contexts
  WHEN OLD.status IN ${OPEN} AND OLD.process_incarnation ${WORKER}
    AND NEW.process_incarnation IS NOT OLD.process_incarnation
  BEGIN INSERT INTO structured_worker_dispatch_ends VALUES (OLD.process_incarnation); END;
CREATE TEMP TRIGGER IF NOT EXISTS structured_worker_dispatch_removed
  AFTER DELETE ON main.dispatch_contexts
  WHEN OLD.status IN ${OPEN} AND OLD.process_incarnation ${WORKER}
  BEGIN INSERT INTO structured_worker_dispatch_ends VALUES (OLD.process_incarnation); END;
CREATE TEMP TRIGGER IF NOT EXISTS structured_worker_custody_released
  AFTER UPDATE OF ownership_state ON main.worker_terminal_resources
  WHEN OLD.ownership_state = 'owned' AND NEW.ownership_state <> 'owned'
    AND OLD.process_incarnation ${WORKER}
  BEGIN INSERT INTO structured_worker_dispatch_ends VALUES (OLD.process_incarnation); END;
`

const watched = new WeakSet<OrchestrationDb>()

/** Starts recording on `db`; ends before this are not reported. */
export function watchStructuredWorkerDispatchEnds(db: OrchestrationDb): void {
  if (!watched.has(db)) {
    db.db.exec(WATCH)
    watched.add(db)
  }
}

/** The worker incarnations whose Dispatch work ended since the last call, each once. */
export function takeStructuredWorkerDispatchEnds(db: OrchestrationDb): readonly string[] {
  if (!watched.has(db)) {
    watchStructuredWorkerDispatchEnds(db)
    return []
  }
  const rows: unknown[] = db.db
    .prepare('DELETE FROM temp.structured_worker_dispatch_ends RETURNING process_incarnation')
    .all()
  return [
    ...new Set(
      rows.flatMap((row) =>
        typeof row === 'object' &&
        row !== null &&
        'process_incarnation' in row &&
        typeof row.process_incarnation === 'string'
          ? [row.process_incarnation]
          : []
      )
    )
  ]
}
