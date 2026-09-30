export const REGISTERED_MIGRATION_ABANDON_MS = 24 * 60 * 60 * 1_000

export const DURABLY_FENCED_MIGRATION_SOURCE = `(
  EXISTS (
    SELECT 1 FROM relay_cell_committed_fences committed_source_fence
    JOIN relay_cell_fence_attempts source_fence_attempt
      ON source_fence_attempt.attempt_id = committed_source_fence.attempt_id
    JOIN relay_cell_runtime source_runtime
      ON source_runtime.cell_id = committed_source_fence.cell_id
    WHERE committed_source_fence.cell_id = migration.source_cell_id
      AND source_fence_attempt.cell_id = committed_source_fence.cell_id
      AND source_fence_attempt.cell_incarnation = committed_source_fence.cell_incarnation
      AND source_fence_attempt.completed_at IS NOT NULL
      AND source_fence_attempt.aborted_at IS NULL
      AND source_runtime.cell_incarnation = committed_source_fence.cell_incarnation
      AND committed_source_fence.attested_at >= source_runtime.last_heartbeat_at
  )
  OR EXISTS (
    SELECT 1 FROM relay_cell_legacy_fence_adoptions adopted_source_fence
    JOIN relay_cell_runtime source_runtime
      ON source_runtime.cell_id = adopted_source_fence.cell_id
    WHERE adopted_source_fence.cell_id = migration.source_cell_id
      AND source_runtime.cell_incarnation = adopted_source_fence.cell_incarnation
      AND adopted_source_fence.attested_at >= source_runtime.last_heartbeat_at
  )
)`

// Ordinary recovery waits on admission age; a completed fence proves the source cannot return.
export const ABANDONED_REGISTERED_MIGRATION = `(
  migration.target_registered_at IS NOT NULL
  AND
  migration.expires_at <= ?
  AND
  (
    EXISTS (
      SELECT 1 FROM relay_cells target_cell
      JOIN relay_cell_admission target_admission
        ON target_admission.cell_id = target_cell.cell_id
      WHERE target_cell.cell_id = migration.target_cell_id
        AND target_cell.enabled = 0
        AND target_admission.admission_state = 'existing-only'
        AND target_admission.updated_at <= ?
    )
    OR (
      EXISTS (
        SELECT 1 FROM relay_cells source_cell
        JOIN relay_cell_admission source_admission
          ON source_admission.cell_id = source_cell.cell_id
        WHERE source_cell.cell_id = migration.source_cell_id
          AND source_cell.enabled = 0
          AND source_admission.admission_state = 'existing-only'
          AND (
            source_admission.updated_at <= ?
            OR ${DURABLY_FENCED_MIGRATION_SOURCE}
          )
      )
      AND EXISTS (
        SELECT 1 FROM relay_cells target_cell
        JOIN relay_cell_admission target_admission
          ON target_admission.cell_id = target_cell.cell_id
        WHERE target_cell.cell_id = migration.target_cell_id
          AND target_cell.enabled = 1
          AND target_admission.admission_state IN ('migration-only', 'general')
      )
      AND NOT EXISTS (
        SELECT 1 FROM relay_assignment_activity_leases source_activity
        WHERE source_activity.user_id = migration.user_id
          AND source_activity.relay_host_id = migration.relay_host_id
          AND source_activity.cell_id = migration.source_cell_id
      )
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM relay_assignment_activity_leases target_control
    WHERE target_control.user_id = migration.user_id
      AND target_control.relay_host_id = migration.relay_host_id
      AND target_control.cell_id = migration.target_cell_id
      AND target_control.activity_kind = 'control'
      AND target_control.activity_id NOT LIKE 'control-pending:%'
  )
)`
