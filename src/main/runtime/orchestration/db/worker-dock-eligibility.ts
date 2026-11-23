export const workerDockEligibleSql = `f.source = ? AND (f.state <> 'succeeded' OR f.report_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM worker_dock_acknowledgments a
    WHERE a.source = f.source AND a.dispatch_id = f.dispatch_id AND a.settlement = f.settlement)
  AND NOT EXISTS (SELECT 1 FROM worker_dock_owner_stops s
    WHERE s.dispatch_id = f.dispatch_id AND s.confirmed = 1 AND s.settlement = f.settlement)`
