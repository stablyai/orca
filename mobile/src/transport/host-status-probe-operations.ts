import { bindDeferredRpcOperation, defineRpcOperation } from './rpc-operation'
import { rpcResultVariant } from './rpc-operation-result-reader'
import { hostStatusSchema, type HostStatusReply } from './host-status-reply-schema'
import type { RpcResponse } from './types'

/**
 * `status.get` as the transport itself asks it: the protocol gate's capability read, the retrying
 * runtime capability probe, and the pairing race's "does this path answer at all".
 *
 * The third named policy on this method, and the second `success-result-or-skip` one. All three
 * transport callers agree that a refusal is an absent answer rather than an error — the gate falls
 * back to closed gates, the probe backs off and re-asks, the race counts the candidate as failed —
 * so they share one operation. It stays separate from the Tasks screen's two (`status.task-runtime`
 * surfaces the host's message, `status.create-capabilities-or-skip` is the create drawer's) because
 * an operation name is what a decode failure reports, and because transport must not import tasks.
 *
 * The readers below exist rather than each caller calling `interpret` directly because neither the
 * probe (which the gate also runs on) nor the race may have an unreadable status thrown at it: both
 * call `interpret` inside a `.then` fulfilment handler, where a throw becomes a detached rejection
 * instead of reaching their rejection handler — the probe would latch capability-gated UI hidden
 * with no retry, and the race would never count the candidate at all.
 */
export const hostStatusProbe = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'status.transport-probe-or-skip',
    method: 'status.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('host-status', hostStatusSchema)
  })
)

/**
 * The status the retrying probe delivers, or `null` for a refusal it should back off from.
 *
 * An unreadable status lands as `{ status: null }` rather than backing off, because that is
 * exactly what main did for the capability read: `Array.isArray(result?.capabilities)` was false
 * for a null, absent or foreign result and the probe published `[]` and stopped. Swallowing the
 * error here rather than at the call site keeps that decision beside the operation whose reader
 * produces it. The wrapper object separates "landed but unreadable" from "refused".
 */
export function readProbedHostStatus(
  reply: RpcResponse
): { status: HostStatusReply | null } | null {
  try {
    const accepted = hostStatusProbe.interpret(reply)
    return accepted.accepted ? { status: accepted.value } : null
  } catch {
    return { status: null }
  }
}

/** The capability projection of `readProbedHostStatus`, kept for callers that only ask that much. */
export function readProbedHostCapabilities(reply: RpcResponse): readonly string[] | null {
  const landed = readProbedHostStatus(reply)
  return landed ? (landed.status?.capabilities ?? []) : null
}

/**
 * Whether the host answered the probe at all, which is the whole of what the pairing race asks.
 *
 * A status the reader cannot decode is still an answer: the candidate's socket completed a request,
 * which is the property the race selects on, and main counted it as a success for the same reason.
 */
export function hostAnsweredStatusProbe(reply: RpcResponse): boolean {
  try {
    return hostStatusProbe.interpret(reply).accepted
  } catch {
    return true
  }
}

/**
 * The status the pairing race attaches to its winner, or `null` when the host's answer is
 * unreadable. Never throws: it runs in the race's fulfilment handler, where a throw would strand
 * the candidate exactly as `hostAnsweredStatusProbe` describes.
 */
export function readPairingCandidateStatus(reply: RpcResponse): HostStatusReply | null {
  return readProbedHostStatus(reply)?.status ?? null
}
