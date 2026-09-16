import { bindDeferredRpcOperation, defineRpcOperation } from './rpc-operation'
import { rpcUncheckedPayloadReader } from './rpc-reader-payload'

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
 * One reader, unchecked, because no caller reads the same field: the gate casts the whole status,
 * the probe re-checks `capabilities` is an array of strings itself, and the race discards it.
 */
export const hostStatusProbe = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'status.transport-probe-or-skip',
    method: 'status.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('host-status')
  })
)
