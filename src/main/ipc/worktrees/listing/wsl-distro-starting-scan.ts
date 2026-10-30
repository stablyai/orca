import type { Store } from '../../../persistence/loading-store/store'
import { getRepoDialableSshTargetId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { runAsWslUserAct, wslDistroForPath } from '../../../wsl/wsl-unc-access-gate'
import { listDetectedWorktreesForCapturedRepo } from './detected-provider-listing'
import { findExactRepoOwner, isCapturedRepoCurrent } from './worktree-host-ownership'

/** A clicked Retry is a user act (E9): the scan may start the repo's stopped distro. Callers re-list after. */
export async function scanWorktreesStartingWslDistro(store: Store, repoId: string): Promise<void> {
  const repo = findExactRepoOwner(store, repoId)
  if (!repo || isFolderRepo(repo) || getRepoDialableSshTargetId(repo)) {
    return
  }
  const distro = wslDistroForPath(
    repo.path,
    getLocalProjectWorktreeGitOptions(store, repo).wslDistro
  )
  if (!distro) {
    return
  }
  await runAsWslUserAct(distro, () =>
    listDetectedWorktreesForCapturedRepo(store, repo, () => isCapturedRepoCurrent(store, repo))
  )
}
