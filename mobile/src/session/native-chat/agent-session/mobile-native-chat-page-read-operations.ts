import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc/rpc-operation-result-reader'
import '../../../terminal/terminal-reply-schema'
import { sessionForwardedReplySchema } from '../../../transport/rpc/rpc-uninterpreted-reply-schemas'
import '../../agent-launch/mobile-agent-detection-reply-schema'
import '../../../files/session-documents/mobile-markdown-tab-reply-schema'
import '../../../terminal/session/mobile-session-terminal-reply-schema'
import '../../../worktree/session-worktree-record-reply-schema'
import '../composer/mobile-native-chat-skill-reply-schema'
import '../../../terminal/quick-commands/mobile-quick-command-reply-schema'
import '../../../files/workspace-file-paths-reply-schema'

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
