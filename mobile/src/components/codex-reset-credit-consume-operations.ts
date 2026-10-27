import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { codexResetCreditReplySchema } from './codex-reset-credit-reply-schema'

// Use require-result-or-throw-message so confirm shows host sentence. Keep payload opaque: call-site decodeResetResult alone checks attempt scope/snapshot.
// Capability probe uses separate status.get policy; combining them would split/move refusal rules.
export const codexResetCreditConsume = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.consume-codex-reset-credit',
    method: 'accounts.consumeCodexResetCredit',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('codex-reset-credit', codexResetCreditReplySchema)
  })
)

/** What the redeem sends with, named from the operation so no module names the raw port. */
export type MobileCodexResetCreditRpcSender = Parameters<typeof codexResetCreditConsume.request>[0]

// Derive scope from operation schema pairing host with no distro and WSL with exact distro; older shared type is wider than invariant.
export type MobileCodexResetCreditSendScope = Parameters<
  typeof codexResetCreditConsume.request
>[1]['expectedScope']
