import type { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { OrchestrationError } from '../orchestration-error'
import { validationScopeKeyForWorktree } from './validation-scope'

/** Correction — who may own or release a lease on THIS workspace.
 *
 *  The check used to be "is this Dispatch on the same Run". A Run holds many
 *  Dispatches in many worktrees, so a Dispatch placed somewhere else entirely
 *  could take — and release — the lease protecting a workspace it has never
 *  touched. Sharing a Run is not authority over a workspace.
 *
 *  Ownership now has to line up exactly: the Dispatch belongs to this Run, to
 *  the Run's admitted outcome, to the named Task, and is placed in the very
 *  worktree the scope key protects.
 */

export type LeaseOwnerAuthority = {
  dispatchId: string
  runId: string
  outcomeId: string
  taskId: string
  worktreeId: string
  /** The scope the lease must use, derived from the worktree above. Callers take
   *  this rather than computing their own: a scope resolved from the coordinator
   *  terminal can name a different workspace than the one the owner Dispatch
   *  actually runs in, and a run-scoped fallback names a workspace the pre-tool
   *  hook has no way to check at all. */
  scopeKey: string
}

/** Resolves and verifies the Dispatch permitted to hold a lease on `scopeKey`.
 *  Throws rather than returning a verdict: every caller must fail closed, and an
 *  optional verdict is one a caller can forget to read. */
export function requireLeaseOwnerAuthority(
  db: OrchestrationDb,
  args: { dispatchId: string; runId: string; taskId: string }
): LeaseOwnerAuthority {
  const dispatch = db.getDispatchContextById(args.dispatchId)
  if (!dispatch || dispatch.run_id !== args.runId) {
    throw new OrchestrationError(
      'invalid_argument',
      `Dispatch ${args.dispatchId} is not a Dispatch on Run ${args.runId}, so it cannot own a lease here.`
    )
  }
  if (dispatch.task_id !== args.taskId) {
    throw new OrchestrationError(
      'invalid_argument',
      `Dispatch ${args.dispatchId} belongs to Task ${dispatch.task_id}, not ${args.taskId}.`
    )
  }
  const worktreeId = db.getWorkerDispatch(args.dispatchId)?.worktree_id
  // Why refuse rather than fall back to a Run scope: the pre-tool hook can only
  // check a WORKTREE scope — it knows the workspace it is running in and nothing
  // about Runs. A run-scoped lease would report as protection while being
  // invisible to the one thing that can stop a worker before it mutates.
  if (!worktreeId) {
    throw new OrchestrationError(
      'invalid_argument',
      `Dispatch ${args.dispatchId} has no worktree the runtime can resolve, so a lease it owned could not be enforced against any workspace.`
    )
  }
  const outcome = new ControlPlaneStore(db).getOutcomeByRun(args.runId)
  // A lease is part of the outcome-admitted validation contract. On a Run with
  // no admitted outcome there is no contract for it to be part of, so granting
  // one would protect nothing while reading as protection.
  if (!outcome) {
    throw new OrchestrationError(
      'outcome_not_admitted',
      `Run ${args.runId} has no admitted outcome, so a validation lease would guard nothing.`
    )
  }
  return {
    dispatchId: args.dispatchId,
    runId: args.runId,
    outcomeId: outcome.outcome_id,
    taskId: dispatch.task_id,
    worktreeId,
    scopeKey: validationScopeKeyForWorktree(worktreeId)
  }
}
