import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  agentHistoryHostStatusSchema,
  agentHistorySessionScanSchema,
  resumeMetadataListSchema,
  resumeRepoListSchema
} from './agent-history-reply-schema'

// The agent-history screen's own reads: the capability gate and session scan it runs on open, and
// the workspace metadata the resume sheet loads once the user asks to resume a session.

/**
 * The capability gate. A second `status.get` family, alongside the Tasks screen's hydration read
 * in mobile-task-runtime-operations.ts: both raise the host's message, but this one is a screen's
 * own error state while that one fails a hydration barrier, so the two are not one family. The
 * reader is the same unchecked payload read, so the method still has one decoding.
 */
export const agentHistoryHostStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'status.agent-history',
    method: 'status.get',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('host-status', agentHistoryHostStatusSchema)
  })
)

export const agentHistorySessionScan = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'aiVault.session-scan',
    method: 'aiVault.listSessions',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('agent-sessions', agentHistorySessionScanSchema)
  })
)

/**
 * Repo identities, the one resume read whose refusal fails the sheet. The member read stays at the
 * call site: main read `.repos` off the cast result at the return statement, so a null result threw
 * a raw TypeError there, and a reader throw would instead be caught by the refusal fallback below
 * and re-thrown as a plain Error.
 */
export const resumeRepoListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.resume-metadata',
    method: 'repo.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('resume-repos', resumeRepoListSchema)
  })
)

// The rest of the resume metadata is enrichment: each degrades to an empty list, so a refusal is a
// skip and the member read stays at the call site, where main's optional chaining tolerated a null
// result instead of throwing on it.

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
