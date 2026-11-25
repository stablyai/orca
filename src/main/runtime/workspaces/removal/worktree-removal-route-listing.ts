import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { RuntimeWorktreeRemovalTarget } from '../catalog/runtime-worktree-selection'
import { resolveWorktreeRemovalMetadata } from '../../../workspaces/removal/worktree-removal-repo-owner'
import { resolveWorktreeRemovalHome } from '../../../workspaces/removal/worktree-removal-execution-host-route'
import { findRegisteredDeletableWorktree } from '../../../workspaces/removal/worktree-removal-safety'
import { authorizeUnregisteredWindowsRemoval } from '../../../git/worktrees/removal/windows-worktree-removal'
import type { WorktreeRemovalExpectation } from '../../../workspaces/removal/worktree-removal-expectation'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { ProjectRuntimeResolutionStore } from '../../../workspaces/execution-host/local-project-runtime-resolution'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { WorktreeRemovalRoute } from '../../../workspaces/removal/worktree-removal-execution-host-route'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { listWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'

/** Require a validated local removal route before listing, preventing reads before non-local hosts are refused. */
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

export async function selectWorktreeOnRemovalRoute({
  route,
  repo,
  store,
  target,
  hostId,
  force,
  expectation
}: {
  route: WorktreeRemovalRoute
  repo: Repo
  store: RuntimeStore
  target: RuntimeWorktreeRemovalTarget
  hostId: ExecutionHostId
  force: boolean
  expectation?: WorktreeRemovalExpectation
}) {
  const listing = await listWorktreesOnRemovalRoute(route, repo, store)
  const removedMeta = resolveWorktreeRemovalMetadata(store, target.repoId, target.id, hostId)
  const registeredWorktree = findRegisteredDeletableWorktree(
    repo.path,
    target.path,
    listing.registeredWorktrees,
    resolveWorktreeRemovalHome(route)
  )
  if (expectation && !registeredWorktree) {
    throw new Error('The reviewed Git workspace is no longer registered.')
  }
  await authorizeUnregisteredWindowsRemoval(
    !!registeredWorktree,
    repo.path,
    target.path,
    force,
    listing.localWorktreeGitOptions
  )
  return {
    ...listing,
    removedMeta,
    registeredWorktree,
    removedPushTarget: removedMeta?.pushTarget ?? target.pushTarget
  }
}
