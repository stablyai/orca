import { createHash } from 'node:crypto'
import type { OrchestrationDb } from '../db'
import { exposeUtcTimestamp } from '../db/utc-timestamp'
import type { DispatchContextRow } from '../types'
import type { CompletionClaim } from './completion-receipt'
import { ControlPlaneStore } from './control-plane-store'
import { readDispatchRouteIdentity } from './dispatch-route-identity'
import { recordGateReceipt } from './gate-receipt-validity'
import { ModelPerformanceLedger, type FirstPassResult } from './model-performance-ledger'
import { resolveOutcomeBinding } from './outcome-identity'
import { executePlan, publishReviewComplete } from './lifecycle-advance-execution'
import { OutcomePolicyStore, type OutcomePhaseRow } from './outcome-policy'
import { planNextAfterBuild, type ReviewerAdvancePlan } from './reviewer-advance'
import { RouteRegistryStore } from './route-registry-store'
import type { RouteIdentity } from './route-registry-types'
import { releaseValidationLease } from './validation-lease'

/** B7/B8/B9 + ledger (correction 2) — the production owner that runs the moment
 *  a completion receipt is validated on an outcome-admitted Run.
 *
 *  State machine (per outcome):
 *    trigger                     immediate state  writer                next state
 *    ---------------------------------------------------------------------------
 *    build completion validated  advancing        advanceAfterCompletion review phase planned
 *    review completion, defects  advancing        advanceAfterCompletion fix_first phase planned
 *    review completion, clean    advancing        advanceAfterCompletion review_complete wake
 *    no certified route          advancing        advanceAfterCompletion protected blocker
 *  Idempotency: the phase table's unique (source_dispatch_id, kind) index makes
 *  a replayed completion reuse the phase it already created — never a second
 *  reviewer Task. Transaction boundary: the caller runs this immediately after
 *  `settleWorkerReport`, inside the same reconcile turn.
 *  Crash recovery: everything it writes is derivable again from the same
 *  completion, so re-running after a crash converges.
 */

/** The chain terminates here: an independent reviewer accepted the delivered
 *  commit, so there is no further phase to plan. */
export type ReviewCompletePlan = { kind: 'review_complete'; boundSha: string }

export type AdvanceOutcome =
  | { kind: 'not_applicable'; reason: string }
  | {
      kind: 'advanced'
      plan: ReviewerAdvancePlan | ReviewCompletePlan
      phase: OutcomePhaseRow | null
      gateReceiptRecorded: boolean
      leaseReleased: boolean
      ledgerEntryId: string | null
      wakeMessageId: string | null
    }

export type AdvanceRequest = {
  db: OrchestrationDb
  dispatch: DispatchContextRow
  taskId: string
  claim: CompletionClaim
  /** Corrections the completing worker reported; non-empty drives FIX_FIRST. */
  corrections: readonly string[]
  /** Paths the completion claimed to have changed; bound into the gate receipt. */
  filesModified: readonly string[]
  outcomeOfReport: 'succeeded' | 'failed'
  nowMs: number
  currentCommitSha?: string
  currentRuntimeVersion?: string
  notify?: (handle: string, messageType: string) => void
}

function gateScopeKey(runId: string, outcomeId: string): string {
  return `${runId}:${outcomeId}`
}

function hashFiles(files: readonly string[]): Record<string, string> {
  // Why path-only: the runtime cannot read a remote worker's tree, so the
  // deterministic input it CAN bind is the exact changed-path set the receipt
  // covered. A different file set invalidates the receipt.
  return Object.fromEntries(
    files.map((file) => [file, createHash('sha256').update(file).digest('hex').slice(0, 16)])
  )
}

export function advanceAfterValidatedCompletion(request: AdvanceRequest): AdvanceOutcome {
  const { db, dispatch, taskId, claim, nowMs } = request
  const store = new ControlPlaneStore(db)
  const binding = resolveOutcomeBinding(store, dispatch.run_id)
  if (binding.kind === 'legacy_unbound') {
    return { kind: 'not_applicable', reason: 'Run has no admitted outcome.' }
  }
  const outcome = binding.outcome
  const policyStore = new OutcomePolicyStore(db)
  const policy = policyStore.get(outcome.outcome_id)
  const registryStore = new RouteRegistryStore(db)

  // B8: the receipt the worker just proved becomes a reusable gate receipt,
  // bound to the exact SHA, policy version and command identity it ran under.
  let gateReceiptRecorded = false
  if (claim.receipt) {
    recordGateReceipt(store, {
      scopeKey: gateScopeKey(dispatch.run_id, outcome.outcome_id),
      inputs: {
        gateId: claim.receipt.commandIdentity,
        finalSha: claim.headSha,
        inputHashes: hashFiles(request.filesModified),
        policyVersion: claim.receipt.policyVersion,
        commandIdentity: claim.receipt.commandIdentity
      },
      result: claim.receipt.result,
      recordedAt: new Date(nowMs).toISOString()
    })
    gateReceiptRecorded = true
  }

  // B9: a completing Dispatch can no longer be holding a validation lease.
  // Looked up by owner, not by scope, so a worktree-scoped lease is released
  // even though the completion path only knows the Dispatch.
  const lease = store.findValidationLeaseByOwner(dispatch.id)
  const leaseReleased = lease
    ? releaseValidationLease(store, {
        scopeKey: lease.scope_key,
        leaseId: lease.lease_id,
        nowMs
      }).released
    : false

  const phase = policyStore.findPhaseByTask(taskId)
  policyStore.settlePhase(taskId)
  const isReviewPhase = phase?.kind === 'review'
  const corrections = isReviewPhase ? request.corrections : []
  const observedRoute = readDispatchRouteIdentity(db, dispatch.id)

  // Ledger: measured, evidence-backed, never a ranking.
  const ledgerEntryId = recordLedgerEntry({
    db,
    outcome,
    dispatch,
    policy,
    identity: observedRoute,
    role: isReviewPhase ? 'reviewer' : 'builder',
    firstPassResult: resolveFirstPassResult(request.outcomeOfReport, corrections),
    correctionRounds: policyStore.countCorrectionRounds(outcome.outcome_id),
    nowMs
  })

  // A clean review is the end of the chain: wake the coordinator once with
  // REVIEW_COMPLETE rather than planning another review of the same SHA.
  if (isReviewPhase && corrections.length === 0) {
    const wakeMessageId = publishReviewComplete({
      db,
      runId: dispatch.run_id,
      dispatchId: dispatch.id,
      taskId,
      boundSha: claim.headSha,
      notify: request.notify
    })
    return {
      kind: 'advanced',
      plan: { kind: 'review_complete', boundSha: claim.headSha },
      phase: phase ?? null,
      gateReceiptRecorded,
      leaseReleased,
      ledgerEntryId,
      wakeMessageId
    }
  }

  const plan = planNextAfterBuild({
    completion: {
      taskId,
      dispatchId: dispatch.id,
      runId: dispatch.run_id,
      outcomeId: outcome.outcome_id,
      finalSha: claim.headSha,
      validated: true
    },
    registry: registryStore.listRoutes(),
    evidence: registryStore.listRouteEvidence(),
    nowMs,
    currentCommitSha: request.currentCommitSha,
    currentRuntimeVersion: request.currentRuntimeVersion,
    corrections,
    retainedBuilder: resolveRetainedBuilder(db, phase),
    // The completing Dispatch authored the commit, so it cannot review it.
    excludeRoute: observedRoute,
    reviewerCandidates: policy.reviewerCandidates,
    reviewCapabilities: policy.reviewCapabilities,
    allowUnknownQuota: policy.allowUnknownQuota
  })

  const executed = executePlan({
    ...request,
    outcomeId: outcome.outcome_id,
    policyStore,
    plan,
    phase
  })
  return {
    kind: 'advanced',
    plan,
    phase: executed.phase,
    gateReceiptRecorded,
    leaseReleased,
    ledgerEntryId,
    wakeMessageId: executed.wakeMessageId
  }
}

function resolveFirstPassResult(
  reported: 'succeeded' | 'failed',
  corrections: readonly string[]
): FirstPassResult {
  if (reported === 'failed') {
    return 'failed'
  }
  return corrections.length > 0 ? 'corrections_required' : 'accepted'
}

function resolveRetainedBuilder(
  db: OrchestrationDb,
  phase: OutcomePhaseRow | undefined
): Parameters<typeof planNextAfterBuild>[0]['retainedBuilder'] {
  if (!phase?.source_dispatch_id) {
    return undefined
  }
  // Why the phase's source dispatch: on a review completion the phase points
  // back at the BUILD Dispatch, which is exactly the session FIX_FIRST must
  // re-engage — never the reviewer that raised the corrections.
  const builderIdentity = readDispatchRouteIdentity(db, phase.source_dispatch_id)
  const builder = db.getDispatchContextById(phase.source_dispatch_id)
  const resource = db.getWorkerTerminalResourceByOwner(phase.source_dispatch_id)
  if (!builder || !resource || !builder.assignee_handle || !builderIdentity) {
    return undefined
  }
  return {
    dispatchId: builder.id,
    terminalHandle: builder.assignee_handle,
    identity: builderIdentity,
    // Why both fields: a pane handed back to the user or already released is no
    // longer a session Orca can re-engage, so FIX_FIRST must not target it.
    sessionRetained:
      resource.ownership_state !== 'released' &&
      resource.ownership_state !== 'user_owned' &&
      resource.release_state !== 'released'
  }
}

function recordLedgerEntry(args: {
  db: OrchestrationDb
  outcome: { outcome_id: string }
  dispatch: DispatchContextRow
  policy: { taskClassification: string }
  identity: RouteIdentity | null
  role: 'builder' | 'reviewer'
  firstPassResult: FirstPassResult
  correctionRounds: number
  nowMs: number
}): string | null {
  if (!args.identity) {
    // Why skip rather than guess: an unobserved route identity would make the
    // ledger a fabrication, and fabricated usage is exactly what is forbidden.
    return null
  }
  // Why exposeUtcTimestamp: the raw column is timezone-less UTC, and parsing it
  // as local time would report a wall clock skewed by the host offset.
  const startedIso = exposeUtcTimestamp(args.dispatch.dispatched_at)
  const startedMs = startedIso ? Date.parse(startedIso) : Number.NaN
  const ledger = new ModelPerformanceLedger(args.db)
  return ledger.record({
    outcomeId: args.outcome.outcome_id,
    dispatchId: args.dispatch.id,
    identity: args.identity,
    modelVersion: args.identity.model ?? 'UNKNOWN',
    role: args.role,
    taskClassification: args.policy.taskClassification,
    firstPassResult: args.firstPassResult,
    correctionRounds: args.correctionRounds,
    reviewerDefects: 0,
    escapedDefects: 0,
    wallClockMs: Number.isFinite(startedMs) ? args.nowMs - startedMs : null,
    // Tool calls, context and quota are not observable from the completion
    // path; they stay null rather than being invented.
    toolCalls: null,
    contextTokensUsed: null,
    providerLimitInterrupted: false,
    rescueIdentity: null,
    provenance: 'observed_runtime',
    recordedAt: new Date(args.nowMs).toISOString()
  }).entry_id
}
