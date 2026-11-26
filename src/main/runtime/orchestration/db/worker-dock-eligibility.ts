import { WORKER_DOCK_FAILURE_LIMIT } from '../../../../shared/orchestration/dock/worker-dock'

// Only a requested stop reaches 'stopped', so a stopped worker leaves the dock like a finished one.
export const workerDockEligibleSql = `f.source = ? AND (f.state <> 'succeeded' OR f.report_id IS NULL)
  AND f.state <> 'stopped'
  AND NOT EXISTS (SELECT 1 FROM worker_dock_acknowledgments a
    WHERE a.source = f.source AND a.dispatch_id = f.dispatch_id AND a.settlement = f.settlement)`

// Indexed ranges keep settled history off the roster path.
export const workerDockCurrentRowsSql = `SELECT * FROM worker_dock_facts INDEXED BY worker_dock_source_state_time
  WHERE source = ? AND state IN ('starting', 'ready', 'stopping')
  UNION ALL
  SELECT * FROM worker_dock_facts INDEXED BY worker_dock_source_state_time
  WHERE source = ? AND state IN ('start_unknown', 'stop_unknown') AND changed_at > ?
  UNION ALL
  SELECT * FROM (
    SELECT f.* FROM worker_dock_facts f INDEXED BY worker_dock_source_state_time
    WHERE f.source = ? AND f.state = 'failed' AND f.changed_at > ?
    AND NOT EXISTS (SELECT 1 FROM worker_dock_acknowledgments a
      WHERE a.source = f.source AND a.dispatch_id = f.dispatch_id AND a.settlement = f.settlement)
    AND NOT EXISTS (SELECT 1 FROM dispatch_contexts d JOIN dispatch_contexts later
      ON later.task_id = d.task_id AND later.rowid > d.rowid WHERE d.id = f.dispatch_id)
    AND NOT EXISTS (SELECT 1 FROM dispatch_contexts d JOIN tasks t ON t.id = d.task_id
      WHERE d.id = f.dispatch_id AND t.status = 'completed')
    ORDER BY f.changed_at DESC, f.dispatch_id COLLATE BINARY LIMIT ${WORKER_DOCK_FAILURE_LIMIT}
  )`
