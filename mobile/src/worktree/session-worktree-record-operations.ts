import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import '../terminal/terminal-reply-schema'
import { sessionWorktreeRecordSchema } from './session-worktree-record-reply-schema'
import '../session/agent-launch/mobile-agent-detection-reply-schema'
import '../files/session-documents/mobile-markdown-tab-reply-schema'
import '../transport/rpc/rpc-uninterpreted-reply-schemas'
import '../terminal/session/mobile-session-terminal-reply-schema'
import '../session/native-chat/composer/mobile-native-chat-skill-reply-schema'
import '../terminal/quick-commands/mobile-quick-command-reply-schema'
import '../files/workspace-file-paths-reply-schema'

// Read the whole worktree for notes and live title; unlike mutation readers, absent records need no error or wrong-host fallback.
export const sessionWorktreeRecordRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.show-record-or-skip',
    method: 'worktree.show',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-record', sessionWorktreeRecordSchema)
  })
)
