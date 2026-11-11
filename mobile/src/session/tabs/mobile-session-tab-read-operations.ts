import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import '../../terminal/terminal-reply-schema'
import { sessionForwardedReplySchema } from '../../transport/rpc/rpc-uninterpreted-reply-schemas'

// Leave replies raw until the controller’s generation, barrier and application-revision guards pass.
export const sessionTabsListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.tabs-list',
    method: 'session.tabs.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('session-tabs-snapshot', sessionForwardedReplySchema)
  })
)
