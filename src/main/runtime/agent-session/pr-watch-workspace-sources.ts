import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { PRWatchWorkspace } from '../../github/pr-watch/pr-watch-types'
import { hostedReviewSshConnectionId } from '../../source-control/hosted-review-execution-host'
import type { ProjectRuntimeResolutionStore } from '../../workspaces/execution-host/local-project-runtime-resolution'
import { getLocalProjectWorktreeGitOptions } from '../../workspaces/execution-host/project-runtime-git-options'
import type { PRWatchRuntimeDeps } from './pr-watch-runtime'

type WorkspaceSourcesRuntime = {
  resolveRuntimeFileTarget(selector: string): Promise<{
    worktree: { repoId: string; path: string; git: { branch: string } }
    executionHostId: ExecutionHostId
  }>
  store: () => ProjectRuntimeResolutionStore & { getRepo(repoId: string): Repo | undefined }
}

function repoSource(
  runtime: WorkspaceSourcesRuntime,
  repo: Repo,
  executionHostId: ExecutionHostId
): Omit<PRWatchWorkspace, 'branch' | 'checkoutPath'> {
  const { wslDistro } = getLocalProjectWorktreeGitOptions(runtime.store(), repo)
  return {
    repoId: repo.id,
    repoPath: repo.path,
    repoKind: repo.kind ?? 'git',
    connectionId: hostedReviewSshConnectionId(executionHostId),
    ...(wslDistro ? { wslDistro } : {})
  }
}

/** A chat's checkout, for the host's CI-line watches. */
export function prWatchWorkspaceSources(
  runtime: WorkspaceSourcesRuntime
): Pick<PRWatchRuntimeDeps, 'resolveWorkspace'> {
  return {
    resolveWorkspace: async (workspaceId) => {
      const { worktree, executionHostId } = await runtime.resolveRuntimeFileTarget(
        `id:${workspaceId}`
      )
      const repo = runtime.store().getRepo(worktree.repoId)
      const branch = worktree.git.branch.replace(/^refs\/heads\//u, '')
      if (repo?.kind === 'folder') {
        return 'not-git'
      }
      // A detached checkout stays usable: pushes name their branch and created PRs their number.
      if (!repo) {
        return null
      }
      return { ...repoSource(runtime, repo, executionHostId), checkoutPath: worktree.path, branch }
    }
  }
}
