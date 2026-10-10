import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { getProjectHostSetupForRepo } from '../../../../shared/project-host-setup-lookup'
import {
  isWorktreePathAdmissibleForHost,
  JOINED_FOREIGN_REGISTRATION
} from '../../../../shared/worktree/worktree-host-path-admissibility'
import { shouldEmitBoundedWarning } from '../../bounded-warning-dedupe'
import { loggedSharedGitCommonDirWarnings } from './worktree-listing-diagnostics'

function registeredPath(worktreePath: string): string {
  return JOINED_FOREIGN_REGISTRATION.exec(worktreePath)?.[1] ?? worktreePath
}

/**
 * Warns when this host's git lists a registration only a sibling host of the same project could
 * have written, i.e. both hosts share one .git. `git worktree prune` or gc on either host then
 * drops the other's registrations (issue #21764). Same-path setups are not evidence: two machines
 * can each hold their own clone at one path.
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
  const foreignPaths = gitWorktrees
    .map((worktree) => registeredPath(worktree.path))
    .filter((path) => !isWorktreePathAdmissibleForHost(path, repo))
  if (foreignPaths.length === 0) {
    return
  }
  // Why candidates, not one sibling: path syntax narrows the writer to hosts that use it, and two
  // such siblings cannot be told apart from here.
  const candidateHostIds = setups
    .filter(
      (sibling) =>
        sibling.projectId === thisSetup.projectId &&
        sibling.hostId !== thisSetup.hostId &&
        foreignPaths.some((path) => isWorktreePathAdmissibleForHost(path, sibling))
    )
    .map((sibling) => sibling.hostId)
  if (candidateHostIds.length === 0) {
    return
  }
  // Why per-pair keys: scans from either side of one shared .git, with differing candidate sets,
  // must still dedupe to one warning.
  const pairKeys = candidateHostIds.map(
    (hostId) => `${thisSetup.projectId}:${[thisSetup.hostId, hostId].sort().join(',')}`
  )
  // Why filter, not some: every pair key must be recorded, not just the first unseen one.
  const unseenKeys = pairKeys.filter((key) =>
    shouldEmitBoundedWarning(loggedSharedGitCommonDirWarnings, key)
  )
  if (unseenKeys.length === 0) {
    return
  }
  const writer =
    candidateHostIds.length === 1 ? candidateHostIds[0] : `one of ${candidateHostIds.join(', ')}`
  console.warn(
    `[worktrees] these hosts share one .git; git worktree prune on either host will drop the other's worktrees (${thisSetup.hostId} and ${writer})`
  )
}
