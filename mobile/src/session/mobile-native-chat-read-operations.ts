import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

/**
 * The older-history page native chat asks for when the transcript is scrolled back.
 *
 * A skip rather than a throw: a refused page leaves the window the subscription already delivered
 * and the scroll simply does not grow, which is what the call site's `if (!response.ok) return`
 * did. There is no screen to raise a host message on — the pane is already showing history.
 *
 * The payload stays whole rather than being narrowed to `messages`, because the reply is a union:
 * an older runtime answers `{ error }` in place of a window, and the caller discriminates on that
 * before it reads a message list. A member reader would have to pick one arm.
 */
export const nativeChatSessionPageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'nativeChat.read-session-page-or-skip',
    method: 'nativeChat.readSession',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('native-chat-session-page')
  })
)
