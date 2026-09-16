import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'
import { rpcReadUnchecked, rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

// The New Workspace drawer's own reads. Its SSH connect, SSH state and agent detection are the
// workspace-create operations in ../tasks/mobile-workspace-source-operations.ts, asked with the
// same acceptance by the same flow, so the drawer sends those rather than restating them.

/**
 * repo.hooks read for the drawer, the second of two policies on this method.
 *
 * The tasks create path (`repo.setup-hooks`) throws the host's message because it cannot decide
 * whether to run setup without an answer. The drawer only decorates a form: a refusal leaves the
 * advanced section on its defaults and the message is never shown, so refusal is a skip here.
 */
export const newWorkspaceSetupHooksRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.drawer-setup-hooks-or-skip',
    method: 'repo.hooks',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('repo-hooks')
  })
)

// Reads `ui` the way the drawer always has: through optional chaining, so a null or absent result
// is untrusted-but-not-fatal rather than the property-read throw the Tasks screen's reader keeps.
const optionalUiMemberReader: RpcCompatibleReader<unknown, 'optional-ui-member', unknown> = (raw) =>
  rpcReadUnchecked('optional-ui-member', raw == null ? undefined : Object(raw).ui)

/** Persisted UI state, read for the trusted-hooks record only. A refused read trusts nothing. */
export const newWorkspaceUiStateRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.new-workspace-trust-or-skip',
    method: 'ui.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: optionalUiMemberReader
  })
)
