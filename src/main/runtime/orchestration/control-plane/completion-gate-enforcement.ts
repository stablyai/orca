import type { ControlPlaneDatabaseHandle } from './control-plane-store'
import { ControlPlaneStore } from './control-plane-store'
import {
  parseCompletionClaim,
  validateCompletionReceipt,
  type CompletionRejection
} from './completion-receipt'
import { resolveOutcomeBinding } from './outcome-identity'

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
