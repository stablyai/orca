import type { AssignmentIdentity } from './assignment-identity-queue.js'
import type { SqlRow } from './database.js'

export type ControlRenewalOutcome =
  | 'renewed'
  | 'assignment_not_found'
  | 'activity_cell_not_authoritative'
  | 'control_activity_not_found'
  | 'control_activity_moved'
  // The host's assignment row was already locked by one of the per-host
  // transactional paths. Retryable, and never a reason to close a control: the
  // next tick is 15s away and the lease has 105s on it.
  | 'assignment_lock_unavailable'
  // Decided per row before the statement runs, so one malformed request cannot
  // cost the rest of the batch its renewal.
  | 'invalid_activity_id'
  | 'invalid_activity_expiry'
  | 'database_error'

// Outcomes the statement itself can report. `database_error` is raised by the
// driver, and `invalid_activity_expiry` is decided per row before the statement
// is built, so neither can come back as a row.
export const CONTROL_RENEWAL_STATEMENT_OUTCOMES = new Set<ControlRenewalOutcome>([
  'renewed',
  'assignment_not_found',
  'activity_cell_not_authoritative',
  'control_activity_not_found',
  'control_activity_moved',
  'assignment_lock_unavailable'
])

export type ControlRenewalRequest = {
  identity: AssignmentIdentity
  activityId: string
  cellId: string
  expiresAt: number
}

// LOCK ORDER - (user_id, relay_host_id), the primary key of relay_assignments,
// applied here and repeated as the statement's ORDER BY so it holds whether the
// planner walks the primary-key index or sorts under the LockRows node.
//
// The batch never waits for an assignment row: SKIP LOCKED reports a contended
// host separately instead. That is what bounds how long a flush holds its locks
// to its own execution time, because row locks live until the statement commits,
// and it is why one host wedged in a per-host transaction cannot stall the
// renewals of every other host sharing the flush.
//
// With no wait on the assignment pass, the deadlock question reduces to the two
// later passes. Every writer in this store locks a host's assignment row before
// that host's lease rows (`assignmentRow` then `lockAssignmentActivities`), and
// a host whose assignment row is held was skipped, so the batch never reaches
// that host's lease: the lease pass cannot wait either.
// `markMigrationTargetRegistered` is the one writer that locks a migration row
// without the assignment row first. It takes no further locks, so it can delay a
// mid-migration row by up to the pool's lock_timeout but cannot close a cycle.
export function orderedControlRenewalRows<Row extends { identity: AssignmentIdentity }>(
  rows: readonly Row[]
): Row[] {
  return [...rows].sort(
    (left, right) =>
      left.identity.userId.localeCompare(right.identity.userId) ||
      left.identity.relayHostId.localeCompare(right.identity.relayHostId)
  )
}

// One statement renewing every due control lease on this cell, row-wise over the
// unnested parameter arrays. Logic per row is what the single-row predecessor
// did: lock the assignment, admit the caller's cell either as the current cell or
// as the source of an active forward migration, lock that host's control lease,
// push both expiries forward, and report one outcome. The one addition is
// `present_assignment`, an unlocked probe that separates a host with no
// assignment row at all from one whose row SKIP LOCKED passed over - the first
// closes the control, the second retries.
export const CONTROL_RENEWAL_BATCH_SQL = `WITH renewal_input AS MATERIALIZED (
           SELECT
             renewal.ordinality AS row_index,
             renewal.user_id,
             renewal.relay_host_id,
             renewal.activity_id,
             renewal.cell_id,
             renewal.expires_at
           FROM unnest(?::text[], ?::text[], ?::text[], ?::text[], ?::bigint[])
             WITH ORDINALITY AS renewal(
               user_id, relay_host_id, activity_id, cell_id, expires_at, ordinality
             )
         ), present_assignment AS MATERIALIZED (
           SELECT input.row_index
           FROM renewal_input input
           JOIN relay_assignments assignment
             ON assignment.user_id = input.user_id
            AND assignment.relay_host_id = input.relay_host_id
         ), assignment_state AS MATERIALIZED (
           SELECT input.row_index, assignment.cell_id, assignment.assignment_epoch
           FROM renewal_input input
           JOIN relay_assignments assignment
             ON assignment.user_id = input.user_id
            AND assignment.relay_host_id = input.relay_host_id
           ORDER BY assignment.user_id, assignment.relay_host_id
           FOR UPDATE OF assignment SKIP LOCKED
         ), migration_state AS MATERIALIZED (
           SELECT locked.row_index
           FROM assignment_state locked
           JOIN renewal_input input ON input.row_index = locked.row_index
           JOIN relay_assignment_migrations migration
             ON migration.user_id = input.user_id
            AND migration.relay_host_id = input.relay_host_id
            AND migration.source_cell_id = input.cell_id
            AND migration.target_cell_id = locked.cell_id
            AND migration.assignment_epoch = locked.assignment_epoch
            AND migration.completed_at IS NULL AND migration.aborted_at IS NULL
           ORDER BY migration.user_id, migration.relay_host_id
           FOR UPDATE OF migration
         ), authorization_state AS MATERIALIZED (
           SELECT locked.row_index
           FROM assignment_state locked
           JOIN renewal_input input ON input.row_index = locked.row_index
           WHERE locked.cell_id = input.cell_id
              OR EXISTS (
                SELECT 1 FROM migration_state moving
                WHERE moving.row_index = locked.row_index
              )
         ), lease_state AS MATERIALIZED (
           SELECT authorized.row_index, lease.activity_kind, lease.cell_id
           FROM authorization_state authorized
           JOIN renewal_input input ON input.row_index = authorized.row_index
           JOIN relay_assignment_activity_leases lease
             ON lease.user_id = input.user_id
            AND lease.relay_host_id = input.relay_host_id
            AND lease.activity_id = input.activity_id
           ORDER BY lease.user_id, lease.relay_host_id, lease.activity_id
           FOR UPDATE OF lease
         ), renewed_lease AS (
           UPDATE relay_assignment_activity_leases lease
           SET expires_at = GREATEST(lease.expires_at, input.expires_at),
               updated_at = GREATEST(lease.updated_at, ?)
           FROM lease_state state
           JOIN renewal_input input ON input.row_index = state.row_index
           WHERE lease.user_id = input.user_id
             AND lease.relay_host_id = input.relay_host_id
             AND lease.activity_id = input.activity_id
             AND state.activity_kind = 'control' AND state.cell_id = input.cell_id
           RETURNING state.row_index
         ), renewed_assignment AS (
           -- Grouped per host: an UPDATE whose FROM offers a target row more than
           -- once applies one source row and returns one, so two leases on one
           -- host would leave the assignment carrying the wrong expiry. The
           -- aggregate hands it exactly one row, carrying the later expiry.
           UPDATE relay_assignments assignment
           SET lease_expires_at = GREATEST(assignment.lease_expires_at, renewed.expires_at),
               last_activity_at = GREATEST(assignment.last_activity_at, ?)
           FROM (
             SELECT input.user_id, input.relay_host_id, MAX(input.expires_at) AS expires_at
             FROM renewed_lease renewed
             JOIN renewal_input input ON input.row_index = renewed.row_index
             GROUP BY input.user_id, input.relay_host_id
           ) renewed
           WHERE assignment.user_id = renewed.user_id
             AND assignment.relay_host_id = renewed.relay_host_id
           RETURNING renewed.user_id
         )
         SELECT input.row_index, CASE
           WHEN NOT EXISTS (
             SELECT 1 FROM present_assignment present
             WHERE present.row_index = input.row_index
           ) THEN 'assignment_not_found'
           WHEN NOT EXISTS (
             SELECT 1 FROM assignment_state locked WHERE locked.row_index = input.row_index
           ) THEN 'assignment_lock_unavailable'
           WHEN NOT EXISTS (
             SELECT 1 FROM authorization_state authorized
             WHERE authorized.row_index = input.row_index
           ) THEN 'activity_cell_not_authoritative'
           WHEN NOT EXISTS (
             SELECT 1 FROM lease_state state WHERE state.row_index = input.row_index
           ) THEN 'control_activity_not_found'
           WHEN EXISTS (
             SELECT 1 FROM lease_state state
             WHERE state.row_index = input.row_index
               AND (state.activity_kind <> 'control' OR state.cell_id <> input.cell_id)
           ) THEN 'control_activity_moved'
           -- Read from renewed_lease, which has one row per input row. The
           -- assignment update collapses to one row per host, so it cannot answer
           -- for a host that brought two leases to the same batch.
           WHEN EXISTS (
             SELECT 1 FROM renewed_lease renewed
             WHERE renewed.row_index = input.row_index
           ) THEN 'renewed'
           ELSE 'control_activity_not_found'
         END AS outcome
         FROM renewal_input input
         ORDER BY input.row_index`

export function controlRenewalBatchParams(
  rows: readonly ControlRenewalRequest[],
  now: number
): unknown[] {
  return [
    rows.map((row) => row.identity.userId),
    rows.map((row) => row.identity.relayHostId),
    rows.map((row) => row.activityId),
    rows.map((row) => row.cellId),
    rows.map((row) => row.expiresAt),
    now,
    now
  ]
}

// Rows come back ordered by row_index, which is the 1-based position in the
// statement's parameter arrays.
export function readControlRenewalOutcomes(
  rows: SqlRow[],
  expected: number
): ControlRenewalOutcome[] {
  if (rows.length !== expected) throw new Error('missing_control_renewal_outcome')
  return rows.map((row, position) => {
    if (Number(row.row_index) !== position + 1) {
      throw new Error('misordered_control_renewal_outcome')
    }
    const outcome = row.outcome
    if (
      typeof outcome !== 'string' ||
      !CONTROL_RENEWAL_STATEMENT_OUTCOMES.has(outcome as ControlRenewalOutcome)
    ) {
      throw new Error('invalid_control_renewal_outcome')
    }
    // SAFETY: the membership check above is what narrows this string.
    return outcome as ControlRenewalOutcome
  })
}
