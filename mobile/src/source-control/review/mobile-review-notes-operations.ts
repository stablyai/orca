import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import { sessionWorktreeRecordSchema } from '../../worktree/session-worktree-record-reply-schema'
import '../../terminal/terminal-reply-schema'
import '../../terminal/quick-commands/mobile-quick-command-operations'

// Preserve host refusal text for optimistic rollback; the reply's record carries the host's merged notes.
export const sessionWorktreeNotesWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.set-review-notes',
    method: 'worktree.set',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    // Acceptance stays as before; an unreadable record only means no merged notes to show.
    read: rpcResultVariant('worktree-notes-written', sessionWorktreeRecordSchema.catch(undefined))
  })
)
