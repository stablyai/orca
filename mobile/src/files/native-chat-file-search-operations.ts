import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import '../terminal/terminal-reply-schema'
import { workspaceFilePathsSchema } from './workspace-file-paths-reply-schema'
import '../session/agent-launch/mobile-agent-detection-reply-schema'
import './session-documents/mobile-markdown-tab-reply-schema'
import '../transport/rpc/rpc-uninterpreted-reply-schemas'
import '../terminal/session/mobile-session-terminal-reply-schema'
import '../worktree/session-worktree-record-reply-schema'
import '../session/native-chat/composer/mobile-native-chat-skill-reply-schema'
import '../terminal/quick-commands/mobile-quick-command-reply-schema'

// Skip refusals to retain suggestions; inspect method_not_found first to fall back from search to inventory.
export const nativeChatFileSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.search-paths-or-skip',
    method: 'files.searchPaths',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-files', workspaceFilePathsSchema)
  })
)

export const nativeChatFileInventoryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.list-or-skip',
    method: 'files.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('workspace-files', workspaceFilePathsSchema)
  })
)
