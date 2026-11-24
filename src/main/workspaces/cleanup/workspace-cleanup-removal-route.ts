import { isWslUncPath } from '../../../shared/file-access/wsl-paths'
import type { Repo } from '../../../shared/repository/repo-types'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { getLocalProjectWorktreeGitOptions } from '../execution-host/project-runtime-git-options'

/**
 * Guarded deletion checks the checkout on this host's process worker right before Git runs. A
 * WSL-routed checkout can't be checked there, so its removal is refused; cleanup must not offer it
 * for deletion either, in the consent preview or the run.
 */
export function createCleanupRemovalRouteCheck(
  store: RuntimeStore
): (repo: Repo, path: string) => boolean {
  const byRepo = new Map<string, boolean>()
  return (repo, path) => {
    if (isWslUncPath(path)) {
      return true
    }
    let unverifiable = byRepo.get(repo.id)
    if (unverifiable === undefined) {
      try {
        unverifiable =
          isWslUncPath(repo.path) ||
          Boolean(getLocalProjectWorktreeGitOptions(store, repo).wslDistro)
      } catch {
        // A project runtime that needs repair can't run Git at all; nothing there is deletable now.
        unverifiable = true
      }
      byRepo.set(repo.id, unverifiable)
    }
    return unverifiable
  }
}
