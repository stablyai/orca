import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { getProjectHostSetupForRepo } from '../../../../shared/project-host-setup-lookup'
import { isWorktreePathAdmissibleForHost } from '../../../../shared/worktree/worktree-host-path-admissibility'
import { isSameCommonDirPath } from '../../../git/worktree-listing'
import { warnOnce, loggedSharedGitCommonDirWarnings } from './worktree-listing-diagnostics'

/**
 * Warns when two execution hosts of one project resolve to the same git common dir.
 * Sharing one .git across execution hosts causes git worktree prune or gc on either
 * host to delete the other host's registrations (issue #21764).
 */
export function warnIfHostsShareGitCommonDir(
  store: Store,
  repo: Repo,
  gitWorktrees: readonly GitWorktreeInfo[]
): void {
  const setups = store.getProjectHostSetups?.()
  if (!setups || setups.length < 2) {
    return
  }

  const thisSetup = getProjectHostSetupForRepo(setups, repo)
  const siblingSetups = setups.filter(
    (setup) => setup.projectId === thisSetup.projectId && setup.hostId !== thisSetup.hostId
  )
  if (siblingSetups.length === 0) {
    return
  }

  for (const sibling of siblingSetups) {
    let sharesCommonDir = false

    if (isSameCommonDirPath(thisSetup.path, sibling.path)) {
      sharesCommonDir = true
    } else {
      for (const worktree of gitWorktrees) {
        if (!worktree.path) {
          continue
        }
        // If a worktree belongs to the sibling's host or path namespace, both hosts share the same .git.
        const belongsToSiblingHost =
          !isWorktreePathAdmissibleForHost(worktree.path, repo) &&
          isWorktreePathAdmissibleForHost(worktree.path, sibling)
        const matchesSiblingPath =
          worktree.path.startsWith(sibling.path) ||
          (Boolean(sibling.worktreeBasePath) &&
            worktree.path.startsWith(sibling.worktreeBasePath!)) ||
          worktree.path.includes(sibling.path)

        if (belongsToSiblingHost || matchesSiblingPath) {
          sharesCommonDir = true
          break
        }
      }
    }

    if (sharesCommonDir) {
      const key = `${thisSetup.projectId}:${thisSetup.hostId}:${sibling.hostId}`
      warnOnce(
        loggedSharedGitCommonDirWarnings,
        key,
        `[worktrees] these hosts share one .git; git worktree prune on either host will drop the other's worktrees`
      )
    }
  }
}
