import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { codexResetCapabilityListSchema } from './codex-reset-credit-reply-schema'

/**
 * status.get read for the Codex reset-credit probe, with its own policy on that method.
 *
 * The probe treats a refusal, a null result and a non-object result identically as "unsupported",
 * which only `object-result-or-null` expresses, and which is what `rpcObjectResultOrNull` already
 * spelled at this call site. The checked reader keeps that: an incompatible reply reaches the same
 * `null` this policy already produced, because `object-result-or-null` is the one policy that never
 * turns an unreadable result into a throw.
 */
export const codexResetCreditCapabilityRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'status.codex-reset-credit-capability',
    method: 'status.get',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('capabilities', codexResetCapabilityListSchema)
  })
)

/** What the probe sends with, named from an operation so no module names the raw port. */
export type MobileCodexResetCapabilityRpcSender = Parameters<
  typeof codexResetCreditCapabilityRead.request
>[0]
