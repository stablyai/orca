export const ASSIGNMENT_CONNECTION_HEADROOM_QUERY =
  `SELECT limits.cell_id, limits.hard_cap, limits.unobserved_bound,
     connection_snapshot.enforced_connection_units,
     connection_snapshot.snapshot_at AS last_heartbeat_at,
     connection_snapshot.cell_incarnation AS connection_incarnation,
     current_runtime.cell_incarnation AS current_incarnation,
     (SELECT COUNT(*) FROM relay_control_connection_reservations reservation
      WHERE reservation.cell_id = limits.cell_id
        AND reservation.state IN
          ('reserved', 'late-arrival-debt', 'claimed')) AS outstanding_reservations
   FROM relay_cell_connection_limits limits
   LEFT JOIN relay_cell_connection_snapshots connection_snapshot
     ON connection_snapshot.cell_id = limits.cell_id
   LEFT JOIN relay_cell_runtime current_runtime
     ON current_runtime.cell_id = limits.cell_id`
