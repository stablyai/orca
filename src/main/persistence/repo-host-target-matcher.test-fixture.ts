import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { RepoHostTarget } from '../../shared/repo-host-identity'

/** Matches an `updateRepo` target for `id` on `hostId`, however the target spells its host. */
export function repoTarget(id: string, hostId: ExecutionHostId = 'local') {
  return {
    asymmetricMatch: (target: RepoHostTarget) =>
      target?.id === id && getRepoExecutionHostId(target) === hostId,
    toString: () => `repoTarget(${id}, ${hostId})`,
    toAsymmetricMatcher: () => `repoTarget(${id}, ${hostId})`
  }
}
