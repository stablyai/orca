import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import '../terminal/terminal-reply-schema'
import { sessionWorktreeRecordSchema } from './session-worktree-record-reply-schema'

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
