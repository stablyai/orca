import { WorktreeRemove } from '../../../../../shared/rpc-contract/workspaces/worktree-params'
import { splitWorktreeId } from '../../../../../shared/worktree/id'
import {
  ArchiveHookApprovalParams,
  type ArchiveHookApproval,
  type ArchiveHookApprovalRequest
} from '../../../../../shared/worktree/removal/archive-hook-decision'
import {
  getRepoDialableSshTargetId,
  isRepoOnCatalogHost,
  normalizeExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { scopeHooksToRepoKind } from '../../../../../shared/folder-workspaces/folder-workspace-hooks'
import {
  projectGroupHookOwner,
  type WorkspaceHookOwner
} from '../../../../../shared/workspace-setup/hooks/workspace-hook-owner'
import { getLocalWorktreeCatalogVersion } from '../../../../workspaces/catalog/local-worktree-scan-generation'
import { resolveWorktreeRemovalRepoOwner } from '../../../../workspaces/removal/worktree-removal-repo-owner'
import {
  archiveTrust,
  readOrcaYamlHooks
} from '../../../../workspace-hooks/archive-hook-trust-content'
import { hashOrcaHookTrustContent } from '../../../../workspace-hooks/created-worktree-setup-trust'
import { getExplicitWorktreeIdSelector } from '../../../workspaces/catalog/runtime-worktree-selection'
import { queueWorkspaceDelete } from '../../../workspaces/lifecycle/workspace-lifecycle-commands'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { defineMethod } from '../../core'
import { waitsForWorktreeRemoval } from '../../workspace-client-views/worktree-removal-marker-projection'
import { resolvePairedCallerHostId } from '../pairing/paired-caller-host-id'

export const WORKTREE_REMOVE_METHOD = defineMethod({
  name: 'worktree.rm',
  permission: 'workspace',
  params: WorktreeRemove,
  handler: async (params, context) => {
    const { runtime } = context
    if (runtime.ownsRecipeWorkspaceRemoval?.(params)) {
      return runtime.removeRecipeWorkspace(params)
    }
    // Translate a paired client's runtime-local host spelling before host-qualified reads.
    let resolvedHostId = resolvePairedCallerHostId(
      () => runtime.listRepos(),
      params.worktree,
      params.hostId
    )
    // Older mobile omits hostId; resolve ambiguity before pinning removal and refuse ids shared by two hosts.
    if (!resolvedHostId) {
      try {
        resolvedHostId = (await runtime.showManagedWorktree(params.worktree)).hostId
        if (!resolvedHostId) {
          throw new Error('worktree.rm could not resolve the workspace host')
        }
      } catch (error) {
        // Git may omit a stale path: selector_not_found must reach removeManagedWorktree; propagate other resolution failures.
        if (!(error instanceof Error) || error.message !== 'selector_not_found') {
          throw error
        }
      }
    }
    // Parse id: selectors for repo stamping; resolving again scans and rejects ids shared by hosts. Leave other selectors unstamped.
    const explicitWorktreeId = getExplicitWorktreeIdSelector(params.worktree)
    const repoId = explicitWorktreeId ? splitWorktreeId(explicitWorktreeId)?.repoId : undefined
    const result = await queueWorkspaceDelete(
      runtime,
      params.worktree,
      resolvedHostId,
      params,
      async (removal) => {
        const options = {
          ...removal,
          waitForBackgroundRemoval: waitsForWorktreeRemoval(context, params)
        }
        return params.approvedNestedWorktrees
          ? runtime.removeManagedWorktreeWithNested(
              params.worktree,
              params.approvedNestedWorktrees,
              options
            )
          : runtime.removeManagedWorktree(params.worktree, options)
      }
    )
    return {
      removed: result.removing !== true,
      ...result,
      ...(repoId ? { catalogVersion: getLocalWorktreeCatalogVersion(repoId) } : {})
    }
  }
})

/** Asked of the desktop runtime: what its window's Delete would do with this workspace's archive hook. */
export const WORKTREE_ARCHIVE_HOOK_APPROVAL_METHOD = defineMethod({
  name: 'worktree.archiveHookApproval',
  permission: 'workspace',
  params: ArchiveHookApprovalParams,
  handler: async (params, { runtime }) => {
    const answer = await runtime.requestArchiveHookApproval(params)
    return answer.decision === 'undecided' ? approvalWithoutDesktop(runtime, params) : answer
  }
})

/** Without the window's approvals, only a hook that needs none can be decided: absent, or local-only. */
async function approvalWithoutDesktop(
  runtime: OrcaRuntimeService,
  params: ArchiveHookApprovalRequest
): Promise<ArchiveHookApproval> {
  let owner: WorkspaceHookOwner | null | undefined
  try {
    if ('folderWorkspaceId' in params) {
      const workspace = runtime
        .listVisibleFolderWorkspaces()
        .find((entry) => entry.id === params.folderWorkspaceId)
      const group = runtime
        .listVisibleProjectGroups()
        .find((entry) => entry.id === workspace?.projectGroupId)
      owner = group && projectGroupHookOwner(group)
    } else {
      owner = await resolveWorktreeHookOwner(runtime, `id:${params.worktreeId}`, params.hostId)
    }
  } catch {
    owner = undefined
  }
  if (!owner || getRepoDialableSshTargetId(owner) || !isRepoOnCatalogHost(owner)) {
    return { decision: 'undecided' }
  }
  const shared = scopeHooksToRepoKind(owner, await readOrcaYamlHooks(owner.path))
  // Pin "nothing needed approval" so a script added before the delete is refused, not run.
  return archiveTrust(owner, shared) === null
    ? { decision: 'run', approvedArchiveHash: hashOrcaHookTrustContent('') }
    : { decision: 'undecided' }
}

async function resolveWorktreeHookOwner(
  runtime: OrcaRuntimeService,
  selector: string,
  hostId: string | undefined
): Promise<WorkspaceHookOwner | undefined> {
  const worktree = await runtime.showManagedWorktree(selector)
  const repos = runtime.listRepos()
  const owner = resolveWorktreeRemovalRepoOwner(
    { getRepos: () => repos, getRepo: (id) => repos.find((repo) => repo.id === id) },
    worktree.repoId,
    normalizeExecutionHostId(hostId ?? worktree.hostId) ?? undefined
  )
  return owner.kind === 'resolved' ? owner.repo : undefined
}
