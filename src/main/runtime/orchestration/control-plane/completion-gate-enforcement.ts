import type { OrchestrationDb } from '../db'
import { ControlPlaneStore, type ControlPlaneDatabaseHandle } from './control-plane-store'
import {
  parseCompletionClaim,
  validateCompletionReceipt,
  type CompletionClaim,
  type CompletionGateReceipt,
  type CompletionRejection
} from './completion-receipt'
import { resolveOutcomeBinding } from './outcome-identity'
import { observeCompletion } from './runtime-observed-completion'
import { hasRuntimeProvenGate } from './runtime-gate-execution'
import { isReadOnlyPhaseKind, readDispatchPhaseKind } from './dispatch-phase-role'
import { fingerprintGateDependencies } from './gate-dependency-fingerprint'

export * from './lifecycle-advance-failure'

/** B6 — where the completion gate actually bites, on the `worker_done` path.
 *
 *  Compatibility: the gate applies ONLY to a Run with an admitted outcome. A
 *  historical Run written before this package existed has no outcome row, so
 *  its completions reconcile exactly as before and its rows stay readable and
 *  unchanged. That is the compatibility fallback, and it fails closed for new
 *  writes: once a Run is admitted, every completion on it must pass the gate.
 *
 *  Every REQUIRED gate must be proven, not just the one the worker chose to
 *  name. A worker that ran one cheap gate and reported it cannot satisfy an
 *  outcome whose spec requires three.
 *
 *  Retry idempotency: the verdict is a pure function of the claim and the
 *  runtime's own observations, so a resend of the same `worker_done` produces
 *  the same verdict, and the existing settle-path duplicate handling makes an
 *  accepted resend a no-op.
 */

export type CompletionGateVerdict =
  | { applies: false }
  | {
      applies: true
      ok: true
      finalSha: string
      /** Paths the RUNTIME derived from Git in the Dispatch worktree. The
       *  worker's own list never narrows or rewrites this. */
      changedFiles: readonly string[]
      claim: CompletionClaim
    }
  | ({ applies: true } & CompletionRejection)

/** The commit this Dispatch started from, as the runtime recorded it at launch.
 *  Null when it was never recorded, which makes the changed-file set the head
 *  commit's own diff rather than a guess. */
function readDispatchBaseSha(db: OrchestrationDb, dispatchId: string): string | null {
  const worker = db.getWorkerDispatch(dispatchId)
  if (!worker) {
    return null
  }
  try {
    const options = JSON.parse(worker.start_options) as { baseSha?: unknown }
    return typeof options.baseSha === 'string' && options.baseSha.length > 0
      ? options.baseSha
      : null
  } catch {
    return null
  }
}

export function evaluateCompletionGate(args: {
  handle: ControlPlaneDatabaseHandle
  runId: string
  taskId: string
  dispatchId: string
  payload: Record<string, unknown>
  /** The outcome the worker reported. A failed report is still settled, but it
   *  can never satisfy the gates or advance the lifecycle. */
  reportedOutcome?: string
  currentRuntimeVersion?: string
}): CompletionGateVerdict {
  const store = new ControlPlaneStore(args.handle)
  const binding = resolveOutcomeBinding(store, args.runId)
  if (binding.kind === 'legacy_unbound') {
    return { applies: false }
  }
  // A FAILED report is settled as failed; it never satisfies a gate and never
  // advances the lifecycle. Running the gate against it rejected the report
  // instead, so the Dispatch could neither pass nor settle — failed work was
  // stranded rather than contained. `reportedOutcome` was declared for exactly
  // this and was never read.
  if (args.reportedOutcome !== undefined && args.reportedOutcome !== 'succeeded') {
    return { applies: false }
  }
  // The worker's block is ADVISORY. Identity, SHA, cleanliness and gate proof
  // all come from the runtime; a fabricated outcome id or a missing block
  // changes nothing, because nothing the worker writes is read as evidence.
  const parsed = parseCompletionClaim(args.payload)
  const db = args.handle as unknown as OrchestrationDb
  const observed = observeCompletion({
    db,
    dispatchId: args.dispatchId,
    // Why the base: without it Git falls back to the head commit's own diff,
    // which reports only that commit's files rather than everything this
    // Dispatch changed since it started.
    baseSha: readDispatchBaseSha(db, args.dispatchId)
  })
  const outcomeId = binding.outcome.outcome_id
  if (!observed.observable || !observed.headSha) {
    return {
      applies: true,
      ok: false,
      code: 'missing_head_sha',
      gate: 'head_sha',
      reason:
        observed.reason ??
        `The runtime cannot read the worktree for Dispatch ${args.dispatchId}, so this completion cannot be proven.`
    }
  }
  const worktreeId = db.getWorkerDispatch(args.dispatchId)?.worktree_id ?? ''
  // A review is not a delivery. The build gates bind a DELIVERED commit to the
  // runs that proved it, and a reviewer neither delivers nor runs them —
  // requiring them here would make every review impossible to complete.
  const reviewing = isReadOnlyPhaseKind(readDispatchPhaseKind(db, args.dispatchId))
  const gates = provenGateReceipt({
    store,
    outcomeId,
    runId: args.runId,
    dispatchId: args.dispatchId,
    finalSha: observed.headSha,
    worktreePath: observed.worktreePath,
    worktreeId,
    buildId: args.currentRuntimeVersion ?? ''
  })
  const claim: CompletionClaim = {
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    runId: args.runId,
    outcomeId,
    headSha: observed.headSha,
    claimedSha: observed.headSha,
    worktreeClean: observed.clean === true,
    placement: (parsed.present ? parsed.claim?.placement : undefined) ?? 'local',
    receipt: gates.receipt
  }
  const validation = validateCompletionReceipt(
    claim,
    {
      taskId: args.taskId,
      dispatchId: args.dispatchId,
      runId: args.runId,
      outcomeId,
      // Why required once admitted: an outcome-admitted Run is exactly the case
      // where a PASS bound to the delivered SHA is the whole point — except for
      // a review, which delivers nothing.
      requireReceipt: !reviewing
    },
    observed,
    reviewing ? undefined : gates.proven
  )
  if (!validation.ok) {
    return { applies: true, ...validation }
  }
  return {
    applies: true,
    ok: true,
    finalSha: validation.finalSha,
    changedFiles: observed.changedFiles,
    claim
  }
}

/** True only when EVERY gate the outcome declares required has a runtime-owned,
 *  build-bound, SHA-bound proven execution.
 *
 *  An outcome that declares none is not a free pass: `requireReceipt` above
 *  still demands the worker's own named gate be proven, and a spec-less outcome
 *  is refused by `hasRuntimeProvenGate` for the gate the claim names. */
function provenGateReceipt(args: {
  store: ControlPlaneStore
  outcomeId: string
  runId: string
  dispatchId: string
  finalSha: string
  worktreePath: string | null
  worktreeId: string
  buildId: string
}): { receipt: CompletionGateReceipt | null; proven: boolean } {
  const specs = args.store.listRequiredGateSpecs(args.outcomeId)
  if (specs.length === 0) {
    // Nothing declares what this outcome must prove, so there is no receipt the
    // runtime could issue and nothing to be satisfied by.
    return { receipt: null, proven: false }
  }
  const allProven = specs.every((spec) =>
    hasRuntimeProvenGate(args.store, {
      scopeKey: `${args.runId}:${args.outcomeId}`,
      gateId: spec.gate_id,
      finalSha: args.finalSha,
      buildId: args.buildId,
      runId: args.runId,
      outcomeId: args.outcomeId,
      dispatchId: args.dispatchId,
      worktreeId: args.worktreeId,
      specHash: spec.spec_hash,
      // Recomputed from the SPEC's own declared files, exactly as the recorded
      // execution computed them. A different derivation here would make every
      // legitimately proven gate look like a changed-input mismatch.
      inputHashes: fingerprintGateDependencies({
        spec: {
          gateId: spec.gate_id,
          files: JSON.parse(spec.dependencies_json) as string[]
        },
        fallbackFiles: [],
        cwd: args.worktreePath ?? process.cwd(),
        policyVersion: spec.policy_version,
        commandIdentity: spec.command_identity,
        program: spec.program
      }),
      shaBinding: spec.sha_binding
    })
  )
  // The receipt the runtime issues to ITSELF, describing the gates it declared
  // and ran. Emitted even when unproven so the refusal can name the gate that
  // was not executed, rather than reading as a missing receipt.
  const [first] = specs
  return {
    receipt: {
      sha: args.finalSha,
      result: 'PASS',
      policyVersion: first.policy_version,
      commandIdentity: first.command_identity
    },
    proven: allProven
  }
}
