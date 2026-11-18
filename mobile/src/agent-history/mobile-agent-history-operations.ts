import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import { connectionHostStatusRead } from '../query/host-status-query'
import {
  agentHistoryHostStatusSchema,
  agentHistorySessionScanSchema,
  resumeMetadataListSchema,
  resumeRepoListSchema
} from './agent-history-reply-schema'

// History capability/scan reads run on open; resume workspace metadata waits for explicit user intent.

// Keep status capability family separate from Tasks hydration: both raise host message via same reader, but fail different screen/barrier states.
const agentHistoryHostStatus = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'status.agent-history',
    method: 'status.get',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('host-status', agentHistoryHostStatusSchema)
  })
)

// The screen's aiVault capability is fixed for the desktop process's life, so the connection's status answers it.
export const agentHistoryCapabilityRead = connectionHostStatusRead(agentHistoryHostStatus)

// Live: resume quotes for the desktop's Windows shell setting, which can change while connected.
export const agentHistoryHostStatusRead = connectionHostStatusRead(agentHistoryHostStatus, 'live')

export const agentHistorySessionScan = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'aiVault.session-scan',
    method: 'aiVault.listSessions',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-sessions', agentHistorySessionScanSchema)
  })
)

// repo.list refusal fails resume sheet. Keep member read at caller: null must throw raw TypeError there, outside refusal fallback that rethrows plain Error.
export const resumeRepoListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.resume-metadata',
    method: 'repo.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('resume-repos', resumeRepoListSchema)
  })
)

// Other metadata is best-effort: skip refusal and keep optional member read at caller so null still degrades to empty.

export const resumeFolderWorkspaceListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'folderWorkspace.resume-metadata-or-skip',
    method: 'folderWorkspace.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('resume-folder-workspaces', resumeMetadataListSchema)
  })
)

export const resumeProjectGroupListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'projectGroup.resume-metadata-or-skip',
    method: 'projectGroup.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('resume-project-groups', resumeMetadataListSchema)
  })
)

export const resumeWorktreeListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.resume-metadata-or-skip',
    method: 'worktree.ps',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('resume-worktrees', resumeMetadataListSchema)
  })
)
