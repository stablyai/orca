import type { RelayDatabase } from './database.js'

export async function readRegionCorrectionOutcomes(database: RelayDatabase, now: number) {
  const rows = await database.query(
    `SELECT attempt.source_cell_id, attempt.target_cell_id,
    CASE WHEN attempt.aborted_at IS NOT NULL THEN 'aborted'
      WHEN attempt.completed_at IS NOT NULL THEN 'completed'
      WHEN migration.target_registered_at IS NOT NULL THEN 'registered' ELSE 'registering' END AS state,
    COUNT(*) AS count,
    COALESCE(MAX(CASE WHEN attempt.completed_at IS NULL AND attempt.aborted_at IS NULL
      THEN ? - attempt.created_at ELSE 0 END), 0) AS oldest_open_ms,
    COALESCE(SUM(CASE WHEN attempt.completed_at IS NULL AND attempt.aborted_at IS NULL
      THEN migration.target_reserved_units ELSE 0 END), 0) AS target_reserved_units
    FROM relay_region_rehome_attempts attempt
    JOIN relay_assignment_migrations migration ON migration.user_id = attempt.user_id
      AND migration.relay_host_id = attempt.relay_host_id AND migration.assignment_epoch = attempt.assignment_epoch
    GROUP BY attempt.source_cell_id, attempt.target_cell_id, state
    ORDER BY attempt.source_cell_id, attempt.target_cell_id, state`,
    [now]
  )
  return rows.map((row) => ({
    sourceCellId: String(row.source_cell_id),
    targetCellId: String(row.target_cell_id),
    state: String(row.state),
    count: Number(row.count),
    oldestOpenMs: Number(row.oldest_open_ms),
    targetReservedUnits: Number(row.target_reserved_units)
  }))
}
