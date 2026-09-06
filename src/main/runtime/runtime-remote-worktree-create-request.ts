import type { BrowserWindow } from 'electron'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import { createRemoteWorktree } from '../ipc/worktree-remote'
import type { Store } from '../persistence'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { WorktreeStartupFollowup } from './runtime-worktree-agent-startup'

export type RuntimeRemoteWorktreeCreateArgs = Omit<
  RuntimeManagedWorktreeCreateArgs,
  'repoSelector'
> & {
  startupFollowup?: WorktreeStartupFollowup
}

export async function requestRuntimeRemoteWorktree(
  repo: Repo,
  args: RuntimeRemoteWorktreeCreateArgs,
  store: RuntimeStore
): Promise<CreateWorktreeResult> {
  const headlessWindow = {
    isDestroyed: () => false,
    webContents: { send: () => undefined }
  } as unknown as BrowserWindow
  const result = await createRemoteWorktree(
    {
      repoId: repo.id,
      name: args.name,
      ...(args.displayName ? { displayName: args.displayName } : {}),
      ...(args.displayNameKind ? { displayNameKind: args.displayNameKind } : {}),
      ...(args.baseBranch ? { baseBranch: args.baseBranch } : {}),
      ...(args.compareBaseRef ? { compareBaseRef: args.compareBaseRef } : {}),
      ...(args.branchNameOverride ? { branchNameOverride: args.branchNameOverride } : {}),
      ...(args.runHooks ? { setupDecision: 'run' as const } : {}),
      ...(!args.runHooks && args.setupDecision ? { setupDecision: args.setupDecision } : {}),
      ...(args.sparseCheckout ? { sparseCheckout: args.sparseCheckout } : {}),
      ...(args.linkedIssue != null ? { linkedIssue: args.linkedIssue } : {}),
      ...(args.linkedPR != null ? { linkedPR: args.linkedPR } : {}),
      ...(args.linkedLinearIssue ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
      ...(args.linkedLinearIssueWorkspaceId !== undefined
        ? { linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId }
        : {}),
      ...(args.linkedLinearIssueOrganizationUrlKey !== undefined
        ? { linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey }
        : {}),
      ...(args.linkedGitLabMR != null ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
      ...(args.linkedGitLabIssue != null ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
      ...(args.linkedBitbucketPR != null ? { linkedBitbucketPR: args.linkedBitbucketPR } : {}),
      ...(args.linkedAzureDevOpsPR != null
        ? { linkedAzureDevOpsPR: args.linkedAzureDevOpsPR }
        : {}),
      ...(args.linkedGiteaPR != null ? { linkedGiteaPR: args.linkedGiteaPR } : {}),
      ...(args.linkedWorkItem !== undefined ? { linkedWorkItem: args.linkedWorkItem } : {}),
      ...(args.linkedTaskSourceContext !== undefined
        ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
        : {}),
      ...(args.pushTarget ? { pushTarget: args.pushTarget } : {}),
      ...(args.workspaceStatus ? { workspaceStatus: args.workspaceStatus as never } : {}),
      ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
      ...(args.createdWithAgent ? { createdWithAgent: args.createdWithAgent } : {}),
      ...(args.pendingFirstAgentMessageRename ? { pendingFirstAgentMessageRename: true } : {}),
      ...(args.nameWasGenerated === true ? { nameWasGenerated: true } : {}),
      ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
      ...(args.cliProvenance ? { cliProvenance: args.cliProvenance } : {})
    },
    repo,
    store as unknown as Store,
    headlessWindow
  )
  if (args.comment !== undefined) {
    store.setWorktreeMeta(result.worktree.id, { comment: args.comment })
    result.worktree.comment = args.comment
  }
  return result
}
