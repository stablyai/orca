import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  newWorkspaceRepoHooksSchema,
  newWorkspaceUiTrustSchema
} from './new-workspace-reply-schema'

// Reuse tasks workspace-create operations for SSH connect/state and agent detection; same flow and acceptance policy.

// Drawer repo.hooks only decorates defaults, so refusal skips; Tasks setup path must throw before deciding whether to run.
// Incompatible replies raise RpcIncompatibleReplyError, caught into same default details as prior property-read failure.
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
