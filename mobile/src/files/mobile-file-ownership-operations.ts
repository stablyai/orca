import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  fileOwnershipSshStateSchema,
  fileOwnershipWorktreeSchema
} from './file-ownership-reply-schema'

// All ownership reads must succeed before a write: refusal or malformed replies abort with a named error rather than risking the wrong host.

// Reuse the Tasks runtime-status operation; this gate needs the same fields.
export { taskRuntimeStatusRead as fileOwnershipRuntimeStatusRead } from '../tasks/mobile-task-runtime-operations'

export const fileOwnershipWorktreeRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.file-mutation-owner',
    method: 'worktree.show',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-summary', fileOwnershipWorktreeSchema)
  })
)

export const fileOwnershipSshStateRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ssh.file-mutation-owner-state',
    method: 'ssh.getState',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ssh-connection-state', fileOwnershipSshStateSchema)
  })
)

export type MobileFileOwnershipRpcSender = Parameters<typeof fileOwnershipWorktreeRead.request>[0]
