import type { Repo } from '../../shared/repo-types'
import type { ProjectRuntimeResolutionStore } from '../local-project-runtime-resolution'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { WorktreeRemovalRoute } from '../worktree-removal-execution-host-route'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { listWorktreesStrict } from '../git/worktree'

/**
 * Lists a repo's worktrees on the local host the removal routed to, with its git options. The route
 * is required so a caller cannot list before routing has refused a non-local host.
 */
export async function listWorktreesOnRemovalRoute(
  _route: WorktreeRemovalRoute,
  repo: Repo,
  store: ProjectRuntimeResolutionStore
): Promise<{
  localWorktreeGitOptions: LocalProjectWorktreeGitOptions
  registeredWorktrees: GitWorktreeInfo[]
}> {
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  return {
    localWorktreeGitOptions,
    registeredWorktrees: Object.keys(localWorktreeGitOptions).length
      ? await listWorktreesStrict(repo.path, localWorktreeGitOptions)
      : await listWorktreesStrict(repo.path)
  }
}
