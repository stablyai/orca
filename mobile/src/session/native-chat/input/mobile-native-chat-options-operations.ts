import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc/rpc-operation-result-reader'
import '../../../files/mobile-file-preview-operations'
import { sessionLaunchUnreadReplySchema } from '../../../transport/rpc/rpc-uninterpreted-reply-schemas'
import '../../../agent-history/mobile-ai-vault-resume-reply-schema'
import '../../../browser/tab-navigation/mobile-session-browser-reply-schema'
import '../../../files/session-documents/mobile-file-tap-reply-schema'

export const nativeChatSessionOptionsWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.mutate-native-chat-session-options',
    method: 'settings.mutateNativeChatSessionOptions',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('native-chat-session-options-written', sessionLaunchUnreadReplySchema)
  })
)
