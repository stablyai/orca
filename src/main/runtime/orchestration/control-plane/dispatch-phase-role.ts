import type { OrchestrationDb } from '../db'

/** What KIND of lifecycle phase a Dispatch is executing, when it is executing
 *  one at all.
 *
 *  The runtime already records this: `control_plane_outcome_phases` stores the
 *  phase `kind` against the Task the phase created, and a Dispatch belongs to
 *  exactly one Task. Keying on the Task rather than on
 *  `phase_launches.dispatch_id` means the answer holds before `markStarted` has
 *  stamped the launch row, and for any Dispatch created against that Task.
 *
 *  Nothing read it back, so two different questions were both being answered as
 *  if every Dispatch were a builder:
 *
 *    - a REVIEW dispatch is not a delivery, so the build gates that bind a
 *      delivery to its SHA cannot be required of it; requiring them would make
 *      every review impossible to complete;
 *    - a REVIEW dispatch is read-only work, so it must never acquire mutation
 *      authority over the tree it is reviewing, lease or no lease.
 *
 *  `fix_first` is deliberately NOT a reviewer: it is the retained BUILDER
 *  correcting its own work, and it delivers.
 */
export type DispatchPhaseKind = 'review' | 'fix_first'

export function readDispatchPhaseKind(
  db: OrchestrationDb,
  dispatchId: string
): DispatchPhaseKind | null {
  try {
    const dispatch = db.getDispatchContextById(dispatchId)
    if (!dispatch) {
      return null
    }
    const row = db.db
      .prepare(`SELECT kind FROM control_plane_outcome_phases WHERE task_id = ? LIMIT 1`)
      .get(dispatch.task_id) as { kind?: string } | undefined
    return row?.kind === 'review' || row?.kind === 'fix_first' ? row.kind : null
  } catch {
    // A database without the phase table is a Run that predates the lifecycle;
    // it has no reviewer dispatches to distinguish.
    return null
  }
}

/** True for work that may only READ the workspace it occupies. */
export function isReadOnlyPhaseKind(kind: DispatchPhaseKind | null): boolean {
  return kind === 'review'
}
