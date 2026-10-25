import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { codexResetCapabilityListSchema } from './codex-reset-credit-reply-schema'

// Probe treats refusal/null/non-object/unreadable as unsupported via object-result-or-null; checked reader must never turn this into throw.
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
