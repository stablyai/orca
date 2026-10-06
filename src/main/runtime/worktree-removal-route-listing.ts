import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { WorktreeRemovalRoute } from '../worktree-removal-execution-host-route'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { listWorktreesStrict } from '../git/worktree'

/**
 * Lists a repo's worktrees on the host the removal already routed to, with the git options
 * that host needs. The SSH provider carries its own exec context, so local project options
 * are resolved (and passed) only on the local route — asking for them on an SSH removal is
 * how a remote listing picked up this machine's WSL distro.
 */
export async function listWorktreesOnRemovalRoute(
  route: WorktreeRemovalRoute,
  repo: Repo,
  store: Store
): Promise<{
  localWorktreeGitOptions: LocalProjectWorktreeGitOptions
  registeredWorktrees: GitWorktreeInfo[]
}> {
  if (route.kind === 'ssh') {
    return {
      localWorktreeGitOptions: {},
      registeredWorktrees: await route.provider.listWorktrees(repo.path)
    }
  }
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  return {
    localWorktreeGitOptions,
    registeredWorktrees: Object.keys(localWorktreeGitOptions).length
      ? await listWorktreesStrict(repo.path, localWorktreeGitOptions)
      : await listWorktreesStrict(repo.path)
  }
}
