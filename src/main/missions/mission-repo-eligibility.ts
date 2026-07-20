import type { Repo } from '../../shared/types'
import { isMissionEligibleRepo } from '../../shared/missions'
import { resolveLocalProjectRuntimeForRepo } from '../local-project-runtime-resolution'
import type { Store } from '../persistence'

export const MISSION_NATIVE_LOCAL_ONLY_ERROR = 'mission_native_local_git_repos_only'

/** Mission roots are native filesystem projections in V1. A repo is eligible
 * only when both Git and the session run on the current native host. */
export function isNativeLocalMissionRepo(store: Store, repo: Repo): boolean {
  if (!isMissionEligibleRepo(repo)) {
    return false
  }

  const resolution = resolveLocalProjectRuntimeForRepo(store, repo)
  if (!resolution) {
    return true
  }
  return resolution.status === 'resolved' && resolution.runtime.kind !== 'wsl'
}

export function requireNativeLocalMissionRepos(store: Store, repoIds: readonly string[]): Repo[] {
  const repos = repoIds.map((repoId) => store.getRepo(repoId))
  if (repos.some((repo) => !repo || !isNativeLocalMissionRepo(store, repo))) {
    throw new Error(MISSION_NATIVE_LOCAL_ONLY_ERROR)
  }
  return repos as Repo[]
}
