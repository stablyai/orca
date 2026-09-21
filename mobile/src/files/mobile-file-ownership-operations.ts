import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  fileOwnershipSshStateSchema,
  fileOwnershipWorktreeSchema
} from './file-ownership-reply-schema'

// The three reads that pin which execution host owns a workspace before a file mutation is sent.
// All three share one acceptance because the capture is all-or-nothing: any refusal aborts the
// mutation with the host's own message rather than letting a write land on the wrong host. An
// unreadable reply now aborts it the same way, with the method named, where main read a member off
// the cast payload and either threw a raw TypeError or captured an owner it had not checked.

// The runtime status this gate needs is the one the Tasks screen already asks for, field for
// field. A second operation would only be a second name for the same wire.
export { taskRuntimeStatusRead as fileOwnershipRuntimeStatusRead } from '../tasks/mobile-task-runtime-operations'

/** The workspace row the mutation targets. A null result throws where `result.worktree` did. */
export const fileOwnershipWorktreeRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.file-mutation-owner',
    method: 'worktree.show',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-summary', fileOwnershipWorktreeSchema)
  })
)

/** The SSH connection generation the mutation is expected to still be running on. */
export const fileOwnershipSshStateRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ssh.file-mutation-owner-state',
    method: 'ssh.getState',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ssh-connection-state', fileOwnershipSshStateSchema)
  })
)

/** What an ownership capture sends with, named from an operation so no module names the raw port. */
export type MobileFileOwnershipRpcSender = Parameters<typeof fileOwnershipWorktreeRead.request>[0]
