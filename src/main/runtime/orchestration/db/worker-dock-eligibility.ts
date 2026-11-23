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

/** The strip's current work: live dispatches, launches or stops still unresolved for under an hour,
 *  and recent failures that nobody acknowledged or stopped and that no later dispatch of the same
 *  task replaced. Binds source, then the unknown and failure cutoffs (epoch ms). */
export const workerDockCurrentSql = `f.source = ? AND (f.state IN ('starting', 'ready', 'stopping')
  OR (f.state IN ('start_unknown', 'stop_unknown') AND f.changed_at > ?)
  OR (f.state IN ('failed', 'stopped', 'abandoned') AND f.changed_at > ?
    AND NOT EXISTS (SELECT 1 FROM worker_dock_acknowledgments a
      WHERE a.source = f.source AND a.dispatch_id = f.dispatch_id AND a.settlement = f.settlement)
    AND NOT EXISTS (SELECT 1 FROM worker_dock_owner_stops s
      WHERE s.dispatch_id = f.dispatch_id AND s.confirmed = 1 AND s.settlement = f.settlement)
    AND NOT EXISTS (SELECT 1 FROM dispatch_contexts d JOIN dispatch_contexts later
      ON later.task_id = d.task_id AND later.rowid > d.rowid WHERE d.id = f.dispatch_id)))`
