export const workerDockEligibleSql = `f.source = ? AND (f.state <> 'succeeded' OR f.report_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM worker_dock_acknowledgments a
    WHERE a.source = f.source AND a.dispatch_id = f.dispatch_id AND a.settlement = f.settlement)
  AND NOT EXISTS (SELECT 1 FROM worker_dock_owner_stops s
    WHERE s.dispatch_id = f.dispatch_id AND s.confirmed = 1 AND s.settlement = f.settlement)`

/** How long a ready worker whose agent status is not fresh stays in the strip after its last
 *  change: longer than nearly every worker runs, so only a stale record ages out. */
export const WORKER_DOCK_UNVERIFIED_READY_MS = 24 * 60 * 60_000
/** A launch or stop whose outcome was never seen is fenced off after an hour. */
export const WORKER_DOCK_UNKNOWN_MS = 60 * 60_000
/** A failure stays a current attention item for four hours; after that it lives in history. */
export const WORKER_DOCK_FAILURE_MS = 4 * 60 * 60_000
/** At most this many failures show at once, newest first. */
export const WORKER_DOCK_FAILURE_LIMIT = 4

// Indexed ranges keep settled history off the roster path.
export const workerDockCurrentRowsSql = `SELECT * FROM worker_dock_facts INDEXED BY worker_dock_source_state_time
  WHERE source = ? AND state IN ('starting', 'ready', 'stopping')
  UNION ALL
  SELECT * FROM worker_dock_facts INDEXED BY worker_dock_source_state_time
  WHERE source = ? AND state IN ('start_unknown', 'stop_unknown') AND changed_at > ?
  UNION ALL
  SELECT * FROM (
    SELECT f.* FROM worker_dock_facts f INDEXED BY worker_dock_source_state_time
    WHERE f.source = ? AND f.state IN ('failed', 'stopped') AND f.changed_at > ?
    AND NOT EXISTS (SELECT 1 FROM worker_dock_acknowledgments a
      WHERE a.source = f.source AND a.dispatch_id = f.dispatch_id AND a.settlement = f.settlement)
    AND NOT EXISTS (SELECT 1 FROM worker_dock_owner_stops s
      WHERE s.dispatch_id = f.dispatch_id AND s.confirmed = 1 AND s.settlement = f.settlement)
    AND NOT EXISTS (SELECT 1 FROM dispatch_contexts d JOIN dispatch_contexts later
      ON later.task_id = d.task_id AND later.rowid > d.rowid WHERE d.id = f.dispatch_id)
    ORDER BY f.changed_at DESC, f.dispatch_id COLLATE BINARY LIMIT ${WORKER_DOCK_FAILURE_LIMIT}
  )`
