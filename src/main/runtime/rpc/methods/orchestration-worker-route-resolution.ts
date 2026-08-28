import type { ControlPlaneDatabaseHandle } from '../../orchestration/control-plane/control-plane-store'
import type { OrchestrationDb } from '../../orchestration/db'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { resolveOutcomeBinding } from '../../orchestration/control-plane/outcome-identity'

/** The lookups worker-start needs to describe the work, as opposed to the
 *  assertions that decide whether it may run at all. Split from the admission
 *  file so each stays readable. */

export function resolveBoundOutcomeId(
  handle: ControlPlaneDatabaseHandle,
  runId: string
): string | undefined {
  const binding = resolveOutcomeBinding(new ControlPlaneStore(handle), runId)
  return binding.kind === 'admitted' ? binding.outcome.outcome_id : undefined
}

/** B5 (correction 3) — whether this worker-start is re-engaging a session Orca
 *  already owns in this Run, and which Dispatch it last carried.
 *
 *  Only an explicit `--terminal` reuse qualifies, and only when that terminal's
 *  most recent Dispatch belongs to the same Run and is not the one being
 *  created now. That is exactly the FIX_FIRST shape: same terminal, same
 *  session, new Dispatch for the correction Task.
 */
export function resolveRetainedReengagement(
  db: OrchestrationDb,
  args: { terminal?: string; runId: string; dispatchId: string }
): { previousTaskId: string; previousDispatchId: string } | null {
  if (!args.terminal) {
    return null
  }
  const previous = db.db
    .prepare(
      `SELECT task_id, id FROM dispatch_contexts
       WHERE assignee_handle = ? AND run_id = ? AND id <> ?
       ORDER BY rowid DESC LIMIT 1`
    )
    .get(args.terminal, args.runId, args.dispatchId) as { task_id: string; id: string } | undefined
  return previous ? { previousTaskId: previous.task_id, previousDispatchId: previous.id } : null
}
