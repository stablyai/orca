import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  newWorkspaceRepoHooksSchema,
  newWorkspaceUiTrustSchema
} from './new-workspace-reply-schema'

// The New Workspace drawer's own reads. Its SSH connect, SSH state and agent detection are the
// workspace-create operations in ../tasks/mobile-workspace-source-operations.ts, asked with the
// same acceptance by the same flow, so the drawer sends those rather than restating them.

/**
 * repo.hooks read for the drawer, the second of two policies on this method.
 *
 * The tasks create path (`repo.setup-hooks`) throws the host's message because it cannot decide
 * whether to run setup without an answer. The drawer only decorates a form: a refusal leaves the
 * advanced section on its defaults and the message is never shown, so refusal is a skip here.
 *
 * The skip is also what carries an unreadable reply: the reader answers `compatible: false`, this
 * policy raises `RpcIncompatibleReplyError` naming `repo.hooks`, and
 * use-new-workspace-setup-script.ts:61 catches it into the same default details a property-read
 * throw already landed on.
 */
export const newWorkspaceSetupHooksRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.drawer-setup-hooks-or-skip',
    method: 'repo.hooks',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('repo-hooks', newWorkspaceRepoHooksSchema)
  })
)

/** Persisted UI state, read for the trusted-hooks record only. A refused read trusts nothing. */
export const newWorkspaceUiStateRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.new-workspace-trust-or-skip',
    method: 'ui.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('optional-ui-member', newWorkspaceUiTrustSchema)
  })
)
