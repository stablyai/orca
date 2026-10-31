import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { RepoHostTarget } from '../../shared/repo-host-identity'

export function repoTarget(id: string, hostId: ExecutionHostId = 'local') {
  return {
    asymmetricMatch: (target: RepoHostTarget) =>
      target?.id === id && getRepoExecutionHostId(target) === hostId,
    toString: () => `repoTarget(${id}, ${hostId})`,
    toAsymmetricMatcher: () => `repoTarget(${id}, ${hostId})`
  }
}
