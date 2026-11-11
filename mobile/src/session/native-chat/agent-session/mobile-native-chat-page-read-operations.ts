import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc/rpc-operation-result-reader'
import '../../../terminal/terminal-reply-schema'
import { sessionForwardedReplySchema } from '../../../transport/rpc/rpc-uninterpreted-reply-schemas'

// Retain the live window on refusal and let the caller offer retry; read the whole legacy error/window union before selecting messages.
export const nativeChatSessionPageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'nativeChat.read-session-page-or-skip',
    method: 'nativeChat.readSession',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('native-chat-session-page', sessionForwardedReplySchema)
  })
)
