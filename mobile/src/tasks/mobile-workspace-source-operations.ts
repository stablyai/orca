import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import {
  rpcUncheckedMemberReader,
  rpcUncheckedPayloadReader
} from '../transport/rpc-reader-payload'

// The repo and SSH reads the workspace-create drawer runs: connection state, agent detection,
// repo-owned setup hooks, sparse presets and base-branch search.

const sshConnectionStateReader = rpcUncheckedMemberReader('ssh-connection-state', 'state')

/** Connecting an SSH repo before create. The reply's only read field is `state`. */
export const sshRepoConnectRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ssh.connect-repo',
    method: 'ssh.connect',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: sshConnectionStateReader
  })
)

/** The same field, read by the drawer's state effect and by the pre-create readiness check. */
export const sshRepoStateRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ssh.repo-state',
    method: 'ssh.getState',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: sshConnectionStateReader
  })
)

// Agent detection is advisory: a refused or failed probe leaves the drawer with an empty set and
// the runtime still validates availability before spawning, so refusal is a skip.
export const remoteAgentDetectionRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.detect-remote-agents-or-skip',
    method: 'preflight.detectRemoteAgents',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('detected-agent-ids')
  })
)

/** The local host's agents, for a repo with no SSH connection. */
export const localAgentDetectionRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.detect-agents-or-skip',
    method: 'preflight.detectAgents',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('detected-agent-ids')
  })
)

/** The repo's orca.yaml hooks, which decide whether create must ask before running setup. */
export const repoSetupHooksRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.setup-hooks',
    method: 'repo.hooks',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('repo-hooks')
  })
)

export const repoSparsePresetListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.sparse-preset-list',
    method: 'repo.sparsePresets',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedMemberReader('sparse-presets', 'presets')
  })
)

export const repoSparsePresetSaveRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.save-sparse-preset',
    method: 'repo.saveSparsePreset',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedMemberReader('saved-sparse-preset', 'preset')
  })
)

/**
 * Base-branch search. The payload is unchecked: both callers — the drawer's picker effect and the
 * Smart source picker — spell their own `refDetails ?? refs.map(...)` fallback, and reproducing
 * that in the reader would need a type assertion the operation fence rightly bans.
 */
export const repoBaseRefSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.base-ref-search',
    method: 'repo.searchRefs',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('base-ref-search')
  })
)
