import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import '../../terminal/terminal-reply-schema'
import { sessionForwardedReplySchema } from '../../transport/rpc/rpc-uninterpreted-reply-schemas'
import '../agent-launch/mobile-agent-detection-reply-schema'
import '../../files/session-documents/mobile-markdown-tab-reply-schema'
import '../../terminal/session/mobile-session-terminal-reply-schema'
import '../../worktree/session-worktree-record-reply-schema'
import '../native-chat/composer/mobile-native-chat-skill-reply-schema'
import '../../terminal/quick-commands/mobile-quick-command-reply-schema'
import '../../files/workspace-file-paths-reply-schema'

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
