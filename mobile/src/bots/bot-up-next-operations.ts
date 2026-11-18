import * as z from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'

// Up next's actions; the list itself comes with the bot's Activity.
export const suggestionStart = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.suggestions.start',
    method: 'bots.suggestions.start',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('suggestion-started', z.looseObject({ ask: z.string() }))
  })
)

export const suggestionDismiss = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.suggestions.dismiss',
    method: 'bots.suggestions.dismiss',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('suggestion-dismissed', z.unknown())
  })
)

export const lookAroundNow = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.look-around.look-now',
    method: 'bots.lookAround.lookNow',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('look-started', z.unknown())
  })
)

export const upNextSeen = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.up-next.seen',
    method: 'bots.upNext.seen',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('up-next-seen', z.unknown())
  })
)
