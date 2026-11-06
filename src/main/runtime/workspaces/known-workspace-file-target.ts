import { getRepoHostIdentityForParts } from '../../../shared/repo-host-identity'
import { createRepoRowExecutionHostLookup } from '../../../shared/worktree-execution-host-resolution'
import type { RuntimeWorkspaceCatalog } from './catalog/workspace-catalog'
import type { OrcaRuntimeWithListManagedWorktrees } from './managed-workspace-operations'
import type { OrcaRuntimeWithTransitionGraphReloadToTerminalState } from '../session-graph/session-graph-authority'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { ResolvedWorktree } from './catalog/runtime-worktree-path-identity'
import { resolveWorktreeHostRouting } from './catalog/worktree-launch-host-repo'
import { findRuntimeWorkspaceFileOwner } from '../../../shared/runtime-workspace-file-owner'
import { RuntimePreallocatedTerminalHandles } from '../terminal/identity/preallocated-terminal-handles'
export abstract class OrcaRuntimeWithResolveKnownWorkspaceFileTarget extends RuntimePreallocatedTerminalHandles {
  protected abstract listResolvedWorktrees(
    ...args: Parameters<RuntimeWorkspaceCatalog['listResolvedWorktrees']>
  ): ReturnType<RuntimeWorkspaceCatalog['listResolvedWorktrees']>

  protected abstract buildRuntimeVisibilitySourceMatchersByRepoId(
    ...args: Parameters<
      OrcaRuntimeWithListManagedWorktrees['buildRuntimeVisibilitySourceMatchersByRepoId']
    >
  ): ReturnType<OrcaRuntimeWithListManagedWorktrees['buildRuntimeVisibilitySourceMatchersByRepoId']>

  protected abstract isRuntimeWorktreeVisible(
    ...args: Parameters<OrcaRuntimeWithListManagedWorktrees['isRuntimeWorktreeVisible']>
  ): ReturnType<OrcaRuntimeWithListManagedWorktrees['isRuntimeWorktreeVisible']>

  protected abstract resolveFolderWorkspaceConnectionId(
    ...args: Parameters<
      OrcaRuntimeWithTransitionGraphReloadToTerminalState['resolveFolderWorkspaceConnectionId']
    >
  ): ReturnType<
    OrcaRuntimeWithTransitionGraphReloadToTerminalState['resolveFolderWorkspaceConnectionId']
  >

  protected async resolveKnownWorkspaceFileTarget(
    absolutePath: string,
    executionHostId: ExecutionHostId
  ): Promise<{
    worktree: ResolvedWorktree
    executionHostId: ExecutionHostId
    relativePath: string
  } | null> {
    const targets = new Map<
      string,
      { worktree: ResolvedWorktree; executionHostId: ExecutionHostId }
    >()
    const repos = this.store?.getRepos() ?? []
    const repoOwners = createRepoRowExecutionHostLookup(repos)
    const resolvedWorktrees = await this.listResolvedWorktrees()
    const visibilitySourceMatchersByRepoId =
      this.buildRuntimeVisibilitySourceMatchersByRepoId(resolvedWorktrees)
    for (const worktree of resolvedWorktrees) {
      const routing = resolveWorktreeHostRouting(repos, worktree, repoOwners)
      if (routing.kind === 'ambiguous') {
        continue
      }
      if (
        !this.isRuntimeWorktreeVisible(
          worktree,
          routing.kind === 'resolved'
            ? visibilitySourceMatchersByRepoId.get(
                getRepoHostIdentityForParts(worktree.repoId, routing.hostId)
              )
            : undefined
        )
      ) {
        continue
      }
      const target = {
        worktree,
        executionHostId: routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID
      }
      targets.set(`${target.executionHostId}\0${worktree.id}`, target)
    }
    for (const folderWorkspace of this.store?.getFolderWorkspaces?.() ?? []) {
      try {
        const candidateConnectionId = this.resolveFolderWorkspaceConnectionId(folderWorkspace)
        const worktree = this.folderWorkspaceToResolvedWorktree(folderWorkspace)
        const target = {
          worktree,
          executionHostId: getConnectionExecutionHostId(candidateConnectionId)
        }
        targets.set(`${target.executionHostId}\0${worktree.id}`, target)
      } catch {
        // An ambiguous folder workspace has no single filesystem authority.
      }
    }

    const owner = findRuntimeWorkspaceFileOwner(
      [...targets.values()].map((target) => ({
        workspaceId: target.worktree.id,
        rootPath: target.worktree.path,
        executionHostId: target.executionHostId
      })),
      absolutePath,
      executionHostId
    )
    if (!owner) {
      return null
    }
    const target = targets.get(`${owner.executionHostId}\0${owner.workspaceId}`)
    return target ? { ...target, relativePath: owner.relativePath } : null
  }
}
