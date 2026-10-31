import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  detectedAgentIdsSchema,
  repoBaseRefSearchSchema,
  repoSetupHooksSchema,
  repoSparsePresetListSchema,
  repoSparsePresetSaveSchema,
  sshConnectionStateSchema
} from './workspace-source-reply-schema'

const sshConnectionStateReader = rpcResultVariant('ssh-connection-state', sshConnectionStateSchema)

export const sshRepoConnectRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ssh.connect-repo',
    method: 'ssh.connect',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: sshConnectionStateReader
  })
)

export const sshRepoStateRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ssh.repo-state',
    method: 'ssh.getState',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: sshConnectionStateReader
  })
)

// Agent detection is advisory; the runtime validates availability again before spawning.
export const remoteAgentDetectionRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.detect-remote-agents-or-skip',
    method: 'preflight.detectRemoteAgents',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('detected-agent-ids', detectedAgentIdsSchema)
  })
)

export const localAgentDetectionRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'preflight.detect-agents-or-skip',
    method: 'preflight.detectAgents',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('detected-agent-ids', detectedAgentIdsSchema)
  })
)

export const repoSetupHooksRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.setup-hooks',
    method: 'repo.hooks',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('repo-hooks', repoSetupHooksSchema)
  })
)

export const repoSparsePresetListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.sparse-preset-list',
    method: 'repo.sparsePresets',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('sparse-presets', repoSparsePresetListSchema)
  })
)

export const repoSparsePresetSaveRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.save-sparse-preset',
    method: 'repo.saveSparsePreset',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('saved-sparse-preset', repoSparsePresetSaveSchema)
  })
)

// Callers retain their refDetails-or-refs fallback; neither member is required for older hosts.
export const repoBaseRefSearchRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.base-ref-search',
    method: 'repo.searchRefs',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('base-ref-search', repoBaseRefSearchSchema)
  })
)
