import type { ControlPlaneDatabaseHandle } from '../../orchestration/control-plane/control-plane-store'
import type { OrchestrationDb } from '../../orchestration/db'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import type { resolveOutcomeBinding } from '../../orchestration/control-plane/outcome-identity'
import { assertOutcomeSerializationAllowed } from '../../orchestration/control-plane/outcome-serialization'
import { OutcomePolicyStore } from '../../orchestration/control-plane/outcome-policy'
import { OrchestrationError } from '../../orchestration/orchestration-error'

/** Leaf guards and lookups the worker-start admission path composes.
 *
 *  Split out purely so the admission file stays readable; none of these calls
 *  back into it. */

export function resolveAllowUnknownQuota(
  handle: ControlPlaneDatabaseHandle,
  binding: ReturnType<typeof resolveOutcomeBinding>
): boolean {
  if (binding.kind !== 'admitted') {
    return false
  }
  return new OutcomePolicyStore(handle).get(binding.outcome.outcome_id)?.allowUnknownQuota ?? false
}

export function resolveTerminalWorktreeId(
  handle: ControlPlaneDatabaseHandle,
  terminalHandle: string | undefined
): string | undefined {
  if (!terminalHandle) {
    return undefined
  }
  const row = handle.db
    .prepare(
      `SELECT w.worktree_id AS worktreeId
       FROM worker_dispatches w
       JOIN dispatch_contexts d ON d.id = w.dispatch_id
       WHERE d.assignee_handle = ? AND w.worktree_id IS NOT NULL
       ORDER BY w.rowid DESC LIMIT 1`
    )
    .get(terminalHandle) as { worktreeId: string } | undefined
  return row?.worktreeId
}

export function assertOutcomeNotSerialized(
  handle: ControlPlaneDatabaseHandle,
  runId: string
): void {
  const serialization = assertOutcomeSerializationAllowed({
    db: handle as unknown as OrchestrationDb,
    store: new ControlPlaneStore(handle),
    runId
  })
  if (!serialization.allowed) {
    throw new OrchestrationError('serialized_with_active_outcome', serialization.reason, {
      blockingOutcomeId: serialization.blockingOutcomeId,
      blockingRunId: serialization.blockingRunId,
      blockingDispatchId: serialization.blockingDispatchId
    })
  }
}
