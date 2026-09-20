import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { codexResetCreditReplySchema } from './codex-reset-credit-reply-schema'

/**
 * Redeeming an earned Codex rate-limit reset credit.
 *
 * `require-result-or-throw-message` because the confirm sheet shows the host's own sentence and
 * never a diagnostic code, which is what the raw `throw new Error(response.error.message)` here
 * spelled. The payload stays unread at this boundary: the call site's `decodeResetResult` is a
 * scope-and-snapshot check that rejects a reply whose scope is not the one the attempt claimed,
 * and moving any of it into a reader would split one refusal rule across two places.
 *
 * Separate from the capability probe on `status.get` next door, which answers a different question
 * about the same feature with a different policy.
 */
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

/**
 * The scope the host contract accepts, which pairs each runtime with the distro it may name. The
 * shared `CodexResetCreditExpectedScope` predates that pairing and is one type wider, so the
 * journal's schema is what holds the invariant; taken from the operation so no module here names
 * the params catalog.
 */
export type MobileCodexResetCreditSendScope = Parameters<
  typeof codexResetCreditConsume.request
>[1]['expectedScope']
