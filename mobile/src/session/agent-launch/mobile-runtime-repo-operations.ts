import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import '../../terminal/terminal-reply-schema'
import { runtimeRepoListSchema } from './mobile-agent-detection-reply-schema'
import '../../files/session-documents/mobile-markdown-tab-reply-schema'
import '../../transport/rpc/rpc-uninterpreted-reply-schemas'
import '../../terminal/session/mobile-session-terminal-reply-schema'
import '../../worktree/session-worktree-record-reply-schema'
import '../native-chat/composer/mobile-native-chat-skill-reply-schema'
import '../../terminal/quick-commands/mobile-quick-command-reply-schema'
import '../../files/workspace-file-paths-reply-schema'

export type MobileRuntimeRepoSummary = {
  id: string
  connectionId?: string | null
  executionHostId?: string | null
}

const repoListReader = rpcResultVariant('runtime-repo-list', runtimeRepoListSchema)

// Keep separate refusal policies: connection/agent loaders surface errors, while advisory probes and refreshes retain their previous state.
export const newTabRepoListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.list-for-new-tab',
    method: 'repo.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: repoListReader
  })
)

export const nativeChatRepoListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.list-or-unreadable',
    method: 'repo.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: repoListReader
  })
)
