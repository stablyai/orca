import type { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { fingerprintGateDependencies } from './gate-dependency-fingerprint'
import { resolveOutcomeBinding } from './outcome-identity'
import type { GateShaBinding } from './gate-receipt-validity'
import { observeCompletion } from './runtime-observed-completion'

/** The completion receipt's fingerprint, and how it may be reused.
 *
 *  Blocker 3 — the dependency set is DISCOVERED, not declared. It used to be
 *  the worker's own `filesModified` list, so a worker that under-reported what
 *  it touched produced a receipt that nothing it actually changed could ever
 *  invalidate. Git's diff for the same tree is the runtime's own answer, and
 *  the worker's list is used only where no tree can be read.
 *
 *  Why the readable/unreadable split: the runtime genuinely cannot read a
 *  REMOTE worker's tree, and a path-only fingerprint proves nothing about
 *  content — reusing one across a commit would treat "same files touched" as
 *  "same bytes tested". So a tree we can read is fingerprinted by bytes and its
 *  receipt survives an unrelated commit; a tree we cannot read is bound to its
 *  exact head and never reused.
 */
export function completionGateInputs(
  db: OrchestrationDb,
  dispatchId: string,
  claimedFiles: readonly string[],
  policyVersion: string,
  commandIdentity: string
): { inputHashes: Record<string, string>; shaBinding: GateShaBinding } {
  const observed = observeCompletion({ db, dispatchId })
  if (!observed.observable || !observed.worktreePath) {
    return {
      inputHashes: {
        'config:policyVersion': policyVersion,
        'config:commandIdentity': commandIdentity,
        'files:unreadable': claimedFiles.join(',')
      },
      shaBinding: 'exact_head'
    }
  }
  // Why union rather than Git alone: a file the worker names that Git does not
  // report is still a dependency it claims to have relied on, and dropping it
  // would narrow the set a discovered dependency was meant to widen.
  //
  // The gate's own DECLARED dependencies join it for the same reason from the
  // other direction: a receipt exists to be invalidated when what the gate
  // READS changes, and that set is not implied by what the work happened to
  // touch. Without it a gate whose inputs moved would keep reusing a PASS.
  const files = [
    ...new Set([
      ...observed.changedFiles,
      ...claimedFiles,
      ...declaredGateDependencies(db, dispatchId, commandIdentity)
    ])
  ].sort()
  return {
    inputHashes: fingerprintGateDependencies({
      spec: { gateId: commandIdentity, files },
      fallbackFiles: files,
      cwd: observed.worktreePath,
      policyVersion,
      commandIdentity
    }),
    shaBinding: 'content'
  }
}

/** The files the required-gate spec itself declares, when this dispatch's Run
 *  has an admitted outcome that declares the gate. Empty otherwise, which keeps
 *  legacy Runs fingerprinting exactly as before. */
function declaredGateDependencies(
  db: OrchestrationDb,
  dispatchId: string,
  commandIdentity: string
): readonly string[] {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch) {
    return []
  }
  const store = new ControlPlaneStore(db)
  const binding = resolveOutcomeBinding(store, dispatch.run_id)
  if (binding.kind !== 'admitted') {
    return []
  }
  const spec = store.findRequiredGateSpecByCommandIdentity(
    binding.outcome.outcome_id,
    commandIdentity
  )
  if (!spec) {
    return []
  }
  try {
    return JSON.parse(spec.dependencies_json) as string[]
  } catch {
    return []
  }
}
