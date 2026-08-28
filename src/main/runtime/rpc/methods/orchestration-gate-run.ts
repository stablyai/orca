import { z } from 'zod'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import type { OrchestrationDb } from '../../orchestration/db'
import { resolveOutcomeBinding } from '../../orchestration/control-plane/outcome-identity'
import { runGateWithBarrier } from '../../orchestration/control-plane/runtime-gate-execution'
import { observeCompletion } from '../../orchestration/control-plane/runtime-observed-completion'
import { fingerprintGateDependencies } from '../../orchestration/control-plane/gate-dependency-fingerprint'
import { hasUnprovableDependency } from '../../orchestration/control-plane/gate-dependency-fingerprint'
import { requiredGateDefinition } from '../../orchestration/control-plane/required-gate-spec'
import {
  isCertifiableRuntimeBuildIdentity,
  type RuntimeBuildIdentity
} from '../../orchestration/control-plane/runtime-build-identity'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { requireLeaseOwnerAuthority } from '../../orchestration/control-plane/lease-owner-authority'
import { OptionalString, requiredString } from '../schemas'

/** The verb that makes a completion receipt mean something.
 *
 *  `gates --record --result PASS` lets a caller name a gate, a SHA and a verdict
 *  with nothing having executed. This runs the command through the approved
 *  process wrapper and records what actually happened, so the completion gate
 *  has something real to require. Without it the gate can only ever be FAILED,
 *  never satisfied — which is a rejection machine, not a control plane.
 */

export const MAX_GATE_TIMEOUT_MS = 6 * 60 * 60 * 1000
export const DEFAULT_GATE_TIMEOUT_MS = 30_000
export const GATE_LEASE_MARGIN_MS = 60_000

export const GateRunParams = z.object({
  dispatch: requiredString('--dispatch'),
  gate: requiredString('--gate'),
  /** Compatibility-only assertions. The runtime never executes these values;
   * when supplied they must byte-for-byte match the frozen manifest. */
  program: OptionalString,
  args: OptionalString,
  timeoutMs: z.number().int().positive().max(MAX_GATE_TIMEOUT_MS).optional(),
  run: OptionalString,
  from: requiredString('--from')
})

export async function runGateForDispatch(args: {
  db: OrchestrationDb
  runId: string
  dispatchId: string
  gateId: string
  program?: string
  args?: string
  timeoutMs?: number
  /** The receiving runtime's pinned build identity. Passed in, never resolved
   *  here: one process must have exactly one build identity, and a module that
   *  resolves its own is a second authority that can disagree with it. */
  buildIdentity: RuntimeBuildIdentity
  validationLease: {
    scopeKey: string
    leaseId: string
    runtimeId: string
  }
}): Promise<{
  gate: string
  sha: string
  passed: boolean
  exitCode: number | null
  command: string
  logDigest: string
  processTreeVerified: boolean
}> {
  const store = new ControlPlaneStore(args.db)
  if (!isCertifiableRuntimeBuildIdentity(args.buildIdentity)) {
    throw new OrchestrationError(
      'runtime_build_unverified',
      'Required gates can run only in an immutable clean build whose complete emitted artifact manifest is verified.'
    )
  }
  const binding = resolveOutcomeBinding(store, args.runId)
  if (binding.kind !== 'admitted') {
    throw new OrchestrationError(
      'required_gate_missing',
      `Run ${args.runId} has no admitted outcome and therefore no runtime-owned gate manifest.`
    )
  }
  const dispatch = args.db.getDispatchContextById(args.dispatchId)
  if (!dispatch || dispatch.run_id !== args.runId) {
    throw new OrchestrationError(
      'gate_dispatch_mismatch',
      `Dispatch ${args.dispatchId} does not belong to Run ${args.runId}.`
    )
  }
  const worker = args.db.getWorkerDispatch(args.dispatchId)
  if (!worker?.worktree_id) {
    throw new OrchestrationError(
      'gate_tree_unobservable',
      `Dispatch ${args.dispatchId} has no runtime-owned worktree binding.`
    )
  }
  const authority = requireLeaseOwnerAuthority(args.db, {
    dispatchId: args.dispatchId,
    runId: args.runId,
    taskId: dispatch.task_id
  })
  const lease = store.getValidationLease(args.validationLease.scopeKey)
  const leaseAuthority = store.getValidationLeaseAuthority(
    args.validationLease.scopeKey,
    args.validationLease.leaseId
  )
  if (
    authority.scopeKey !== args.validationLease.scopeKey ||
    !lease ||
    lease.lease_id !== args.validationLease.leaseId ||
    lease.owner !== args.dispatchId ||
    lease.released_at !== null ||
    Date.parse(lease.expires_at) <= Date.now() ||
    !leaseAuthority ||
    leaseAuthority.run_id !== args.runId ||
    leaseAuthority.outcome_id !== binding.outcome.outcome_id ||
    leaseAuthority.task_id !== dispatch.task_id ||
    leaseAuthority.dispatch_id !== args.dispatchId ||
    leaseAuthority.worktree_id !== worker.worktree_id ||
    leaseAuthority.owner_handle !== authority.ownerHandle ||
    leaseAuthority.owner_pane_key !== authority.ownerPaneKey ||
    leaseAuthority.process_incarnation !== authority.processIncarnation ||
    leaseAuthority.launch_token_hash !== authority.launchTokenHash ||
    leaseAuthority.runtime_id !== args.validationLease.runtimeId ||
    leaseAuthority.build_id !== args.buildIdentity.id
  ) {
    throw new OrchestrationError(
      'validation_lease_required',
      `Required gate ${args.gateId} has no active exact-Dispatch validation fence.`
    )
  }
  const gateRow = store.getRequiredGateSpec(binding.outcome.outcome_id, args.gateId)
  if (!gateRow) {
    throw new OrchestrationError(
      'required_gate_missing',
      `Gate ${args.gateId} is not in the immutable manifest for outcome ${binding.outcome.outcome_id}.`
    )
  }
  const gate = requiredGateDefinition(gateRow)
  const assertedArgs = args.args?.split(' ').filter(Boolean)
  if (
    (args.program !== undefined && args.program !== gate.program) ||
    (assertedArgs !== undefined && JSON.stringify(assertedArgs) !== JSON.stringify(gate.args))
  ) {
    throw new OrchestrationError(
      'required_gate_substitution',
      `Gate ${args.gateId} is frozen as ${gate.commandIdentity}; a caller cannot replace its command.`
    )
  }
  // Why the runtime resolves both the tree and the SHA: the point of this verb
  // is that they are observed, not stated. A caller naming either could record a
  // passing gate against a commit it never ran on.
  const observed = observeCompletion({ db: args.db, dispatchId: args.dispatchId })
  if (!observed.observable || !observed.headSha || !observed.worktreePath) {
    throw new OrchestrationError(
      'gate_tree_unobservable',
      observed.reason ??
        `The runtime cannot read the tree for Dispatch ${args.dispatchId}, so it cannot run a gate there.`
    )
  }
  if (observed.clean !== true) {
    throw new OrchestrationError(
      'gate_tree_dirty',
      `Dispatch ${args.dispatchId} worktree must be clean before a required gate starts.`
    )
  }
  const inputHashes = fingerprintGateDependencies({
    spec: { gateId: gate.gateId, files: gate.dependencies },
    fallbackFiles: [],
    cwd: observed.worktreePath,
    policyVersion: gate.policyVersion,
    commandIdentity: gate.commandIdentity
  })
  const unprovable = hasUnprovableDependency(inputHashes)
  if (unprovable) {
    throw new OrchestrationError(
      'gate_dependency_unreadable',
      `Gate ${gate.gateId} dependency ${unprovable} is not runtime-readable.`
    )
  }
  const result = await runGateWithBarrier(store, {
    scopeKey: `${args.runId}:${binding.kind === 'admitted' ? binding.outcome.outcome_id : 'unbound'}`,
    gateId: args.gateId,
    finalSha: observed.headSha,
    program: gate.program,
    args: gate.args,
    cwd: observed.worktreePath,
    buildId: args.buildIdentity.id,
    runId: args.runId,
    outcomeId: binding.outcome.outcome_id,
    dispatchId: args.dispatchId,
    worktreeId: worker.worktree_id,
    policyVersion: gate.policyVersion,
    commandIdentity: gate.commandIdentity,
    specHash: gateRow.spec_hash,
    inputHashes,
    shaBinding: gate.shaBinding,
    validateAfter: () => {
      const after = observeCompletion({ db: args.db, dispatchId: args.dispatchId })
      if (!after.observable || !after.worktreePath) {
        return after.reason ?? 'The gate worktree became unobservable while the process ran.'
      }
      if (after.headSha !== observed.headSha) {
        return `Gate worktree HEAD moved from ${observed.headSha} to ${after.headSha ?? '<none>'}.`
      }
      if (after.clean !== true) {
        return 'Gate worktree became dirty while the process ran.'
      }
      const afterHashes = fingerprintGateDependencies({
        spec: { gateId: gate.gateId, files: gate.dependencies },
        fallbackFiles: [],
        cwd: after.worktreePath,
        policyVersion: gate.policyVersion,
        commandIdentity: gate.commandIdentity
      })
      return JSON.stringify(afterHashes) === JSON.stringify(inputHashes)
        ? null
        : 'Gate dependency bytes changed while the process ran.'
    },
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs })
  })
  if (result.processTreeVerified !== true) {
    throw new OrchestrationError(
      'gate_process_tree_unverified',
      result.validationFailure ?? 'The required gate process tree did not reach terminal exit.',
      { retainValidationFence: true }
    )
  }
  if (result.validationFailure) {
    throw new OrchestrationError('gate_tree_changed', result.validationFailure)
  }
  return {
    gate: args.gateId,
    sha: observed.headSha,
    passed: result.passed,
    exitCode: result.execution.exit_code,
    command: gate.commandIdentity,
    logDigest: result.execution.log_digest,
    processTreeVerified: true
  }
}
