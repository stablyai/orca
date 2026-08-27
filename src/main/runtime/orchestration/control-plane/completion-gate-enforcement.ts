import type { OrchestrationDb } from '../db'
import type { DispatchContextRow } from '../types'
import { ControlPlaneStore } from './control-plane-store'
import { advanceAfterValidatedCompletion, type AdvanceOutcome } from './lifecycle-advance'
import {
  parseCompletionClaim,
  validateCompletionReceipt,
  type CompletionRejection
} from './completion-receipt'
import { resolveOutcomeBinding } from './outcome-identity'
import type { ControlPlaneDatabaseHandle } from './control-plane-store'

/** B6 — where the completion gate actually bites, on the `worker_done` path.
 *
 *  Compatibility: the gate applies ONLY to a Run with an admitted outcome. A
 *  historical Run written before this package existed has no outcome row, so
 *  its completions reconcile exactly as before and its rows stay readable and
 *  unchanged. That is the compatibility fallback, and it fails closed for new
 *  writes: once a Run is admitted, every completion on it must pass the gate.
 *
 *  Retry idempotency: the verdict is a pure function of the claim, so a
 *  resend of the same `worker_done` produces the same verdict, and the existing
 *  settle-path duplicate handling makes an accepted resend a no-op.
 */

export type CompletionGateVerdict =
  | { applies: false }
  | { applies: true; ok: true; finalSha: string }
  | ({ applies: true } & CompletionRejection)

export function evaluateCompletionGate(args: {
  handle: ControlPlaneDatabaseHandle
  runId: string
  taskId: string
  dispatchId: string
  payload: Record<string, unknown>
}): CompletionGateVerdict {
  const store = new ControlPlaneStore(args.handle)
  const binding = resolveOutcomeBinding(store, args.runId)
  if (binding.kind === 'legacy_unbound') {
    return { applies: false }
  }
  const parsed = parseCompletionClaim(args.payload)
  if (!parsed.present) {
    return {
      applies: true,
      ok: false,
      code: 'missing_receipt',
      gate: 'receipt',
      reason: `Run ${args.runId} is outcome-admitted; worker_done must carry a completion block.`
    }
  }
  if (!parsed.claim) {
    return {
      applies: true,
      ok: false,
      code: 'missing_head_sha',
      gate: 'head_sha',
      reason: 'The completion block is malformed or missing required identity/SHA fields.'
    }
  }
  const validation = validateCompletionReceipt(
    { ...parsed.claim, runId: parsed.claim.runId || args.runId },
    {
      taskId: args.taskId,
      dispatchId: args.dispatchId,
      runId: args.runId,
      outcomeId: binding.outcome.outcome_id,
      // Why always required once admitted: an outcome-admitted Run is exactly
      // the case where a PASS bound to the delivered SHA is the whole point.
      requireReceipt: true
    }
  )
  return validation.ok
    ? { applies: true, ok: true, finalSha: validation.finalSha }
    : { applies: true, ...validation }
}

/** Runtime hooks the reconcile path threads through so the control plane can
 *  wake waiters and bind evidence to the current build without importing the
 *  runtime service. All optional: a plain `reconcileLifecycleMessage(db, msg)`
 *  from a test or the in-process coordinator behaves exactly as before. */
export type LifecycleReconciliationHooks = {
  notify?: (handle: string, messageType: string) => void
  currentCommitSha?: string
  currentRuntimeVersion?: string
  nowMs?: number
}

function readStringArray(payload: Record<string, unknown>, key: string): string[] {
  const raw = payload[key]
  return Array.isArray(raw) && raw.every((item) => typeof item === 'string')
    ? (raw as string[])
    : []
}

/** The single production call site for the post-completion lifecycle. Failures
 *  are contained: an advance error must never undo an already-settled, already
 *  gate-proven completion. */
export function advanceAfterAcceptedCompletion(args: {
  db: OrchestrationDb
  dispatch: DispatchContextRow
  taskId: string
  payload: Record<string, unknown>
  finalSha: string
  outcomeOfReport: 'succeeded' | 'failed'
  onLog: (message: string) => void
  hooks?: LifecycleReconciliationHooks
}): AdvanceOutcome | null {
  const parsed = parseCompletionClaim(args.payload)
  if (!parsed.present || !parsed.claim) {
    return null
  }
  try {
    return advanceAfterValidatedCompletion({
      db: args.db,
      dispatch: args.dispatch,
      taskId: args.taskId,
      claim: { ...parsed.claim, headSha: args.finalSha },
      corrections: readStringArray(args.payload, 'corrections'),
      filesModified: readStringArray(args.payload, 'filesModified'),
      outcomeOfReport: args.outcomeOfReport,
      nowMs: args.hooks?.nowMs ?? Date.now(),
      currentCommitSha: args.hooks?.currentCommitSha,
      currentRuntimeVersion: args.hooks?.currentRuntimeVersion,
      notify: args.hooks?.notify
    })
  } catch (error) {
    args.onLog(`Lifecycle advance failed after completion: ${String(error)}`)
    return null
  }
}
