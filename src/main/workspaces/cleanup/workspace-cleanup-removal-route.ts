import { isWslUncPath } from '../../../shared/file-access/wsl-paths'
import type { Repo } from '../../../shared/repository/repo-types'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { resolveLocalProjectRuntimesForRepos } from '../execution-host/local-project-runtime-resolution'

/**
 * Guarded deletion checks the checkout on this host's process worker right before Git runs. A
 * WSL-routed checkout can't be checked there, so its removal is refused; cleanup must not offer it
 * for deletion either, in the consent preview or the run. Project runtimes resolve once per pass.
 */
export function createCleanupRemovalRouteCheck(
  store: RuntimeStore,
  repos: readonly Repo[]
): (repo: Repo, path: string) => boolean {
  const runtimes = resolveLocalProjectRuntimesForRepos(store, repos)
  return (repo, path) => {
    if (isWslUncPath(path) || isWslUncPath(repo.path)) {
      return true
    }
    const resolution = runtimes.get(repo.id)
    if (!resolution) {
      return false
    }
    // A project runtime that needs repair can't run Git at all; nothing there is deletable now.
    if (resolution.status === 'repair-required') {
      return true
    }
    // The same routing Git execution uses: WSL Git unless the project runs Git on the Windows host.
    return resolution.runtime.kind === 'wsl' && resolution.runtime.git !== 'windows-host'
  }
}
