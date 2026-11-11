import type { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree } from '../terminal/launch/terminal-workspace-scope'
import type { OrcaRuntimeWithTransitionGraphReloadToTerminalState } from '../session-graph/session-graph-authority'
import type { ResolvedWorktree } from './catalog/runtime-worktree-path-identity'
import type { Repo } from '../../../shared/repo-types'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getLocalProjectWorktreeGitOptions } from '../../workspaces/execution-host/project-runtime-git-options'
import { resolveWorktreeHostRouting } from './catalog/worktree-launch-host-repo'
import { isFloatingWorkspaceSelector } from '../../../shared/floating-workspace-worktree'
import { RuntimeMarkdownTabOperations } from '../files/paths/runtime-markdown-tab-operations'
export abstract class RuntimeWorkspaceFileTargets extends RuntimeMarkdownTabOperations {
  protected abstract floatingWorkspaceToResolvedWorktree(
    ...args: Parameters<
      OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree['floatingWorkspaceToResolvedWorktree']
    >
  ): ReturnType<
    OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree['floatingWorkspaceToResolvedWorktree']
  >

  protected abstract resolveFloatingWorkspacePath(
    ...args: Parameters<
      OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree['resolveFloatingWorkspacePath']
    >
  ): ReturnType<
    OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree['resolveFloatingWorkspacePath']
  >

  protected abstract resolveFolderWorkspaceLaunchScope(
    ...args: Parameters<
      OrcaRuntimeWithTransitionGraphReloadToTerminalState['resolveFolderWorkspaceLaunchScope']
    >
  ): ReturnType<
    OrcaRuntimeWithTransitionGraphReloadToTerminalState['resolveFolderWorkspaceLaunchScope']
  >

  // Route by worktree host before repo id: same-id host twins and runtime-nested targets cannot use this client's arbitrary repo row (#11163).
  protected async resolveRuntimeGitTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    repo?: Repo
    executionHostId: ExecutionHostId
    localGitOptions?: { wslDistro?: string }
  }> {
    const store = this.requireStore()
    const worktree = await this.resolveGitWorktreeSelector(worktreeSelector)
    const routing = resolveWorktreeHostRouting(store.getRepos(), worktree)
    if (routing.kind === 'ambiguous') {
      throw new Error('worktree_execution_host_unresolved')
    }
    const executionHostId = routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID
    // Metadata only (shared-link paths, source-control AI defaults); routing is `executionHostId`.
    const repo =
      (routing.kind === 'resolved' ? routing.repo : null) ?? store.getRepo(worktree.repoId)
    const localGitOptions =
      repo && executionHostId === LOCAL_EXECUTION_HOST_ID
        ? getLocalProjectWorktreeGitOptions(store, repo)
        : {}
    return { worktree, repo, executionHostId, localGitOptions }
  }

  // Resolve the worktree's filesystem host; getRepo(id) conflates host twins, runtime targets, unresolved owners and local paths (#11163).
  async resolveRuntimeFileTarget(worktreeSelector: string): Promise<{
    worktree: ResolvedWorktree
    executionHostId: ExecutionHostId
  }> {
    // Floating workspaces have no row; resolve their authority centrally.
    if (isFloatingWorkspaceSelector(worktreeSelector)) {
      return {
        worktree: this.floatingWorkspaceToResolvedWorktree(
          await this.resolveFloatingWorkspacePath()
        ),
        executionHostId: LOCAL_EXECUTION_HOST_ID
      }
    }
    const folderScope = await this.resolveFolderWorkspaceLaunchScope(worktreeSelector)
    if (folderScope?.folderWorkspace) {
      // Folder inference already rejects ambiguity; no repo row or runtime-environment owner can override it.
      return {
        worktree: this.folderWorkspaceToResolvedWorktree(folderScope.folderWorkspace),
        executionHostId: getConnectionExecutionHostId(folderScope.connectionId)
      }
    }

    return this.runtimeFileTargetForWorktree(
      await this.resolveGitWorktreeSelector(worktreeSelector)
    )
  }

  protected runtimeFileTargetForWorktree(worktree: ResolvedWorktree): {
    worktree: ResolvedWorktree
    executionHostId: ExecutionHostId
  } {
    const store = this.requireStore()
    const routing = resolveWorktreeHostRouting(store.getRepos(), worktree)
    if (routing.kind === 'ambiguous') {
      throw new Error('worktree_execution_host_unresolved')
    }
    return {
      worktree,
      executionHostId: routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID
    }
  }
}
