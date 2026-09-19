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
 * One reader, but three different meanings for an unreadable status, which is why the three
 * readers below exist rather than each caller calling `interpret` directly. The gate wants the
 * failure (its own `catch` degrades to closed gates), and the probe and the race must not have it:
 * both call `interpret` inside a `.then` fulfilment handler, where a throw becomes a detached
 * rejection instead of reaching their rejection handler — the probe would latch capability-gated UI
 * hidden with no retry, and the race would never count the candidate at all.
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
 * The gate's read. An unreadable status raises `RpcIncompatibleReplyError` naming `status.get`,
 * which host-status-gates.ts already catches into the same closed gates a property read on a null
 * status used to throw its way to.
 */
export function readHostStatusGates(reply: RpcResponse): HostStatusReply | null {
  const accepted = hostStatusProbe.interpret(reply)
  return accepted.accepted ? accepted.value : null
}

/**
 * The capabilities the retrying probe publishes, or `null` for a refusal it should back off from.
 *
 * An unreadable status publishes the empty set rather than backing off, because that is exactly
 * what main did: `Array.isArray(result?.capabilities)` was false for a null, absent or foreign
 * result and the probe published `[]` and stopped. Swallowing the error here rather than at the
 * call site keeps that decision beside the operation whose reader produces it.
 */
export function readProbedHostCapabilities(reply: RpcResponse): readonly string[] | null {
  try {
    const accepted = hostStatusProbe.interpret(reply)
    return accepted.accepted ? (accepted.value.capabilities ?? []) : null
  } catch {
    return []
  }
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
