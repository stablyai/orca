import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export function hasConflictingStoredWorktreeOwner(
  store: Store,
  repo: Repo,
  worktreeIds: readonly string[]
): boolean {
  const expectedHostId = getRepoExecutionHostId(repo)
  const repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
  return worktreeIds.some((worktreeId) => {
    const meta = store.getWorktreeMeta(worktreeId)
    return !!meta && (meta.hostId ? meta.hostId !== expectedHostId : repoOwnerCount > 1)
  })
}

export type RepoOwnershipEvidence =
  | { status: 'owned'; hostId: ExecutionHostId }
  | { status: 'malformed' }
  | { status: 'contradictory' }

export function resolveRepoOwnershipEvidence(repo: Repo): RepoOwnershipEvidence {
  const hasExplicitHost = repo.executionHostId !== null && repo.executionHostId !== undefined
  const explicitHost = hasExplicitHost ? parseExecutionHostId(repo.executionHostId) : null
  if (hasExplicitHost && !explicitHost) {
    return { status: 'malformed' }
  }
  const hasConnection = repo.connectionId !== null && repo.connectionId !== undefined
  const connectionId = hasConnection ? repo.connectionId?.trim() : null
  if (hasConnection && !connectionId) {
    return { status: 'malformed' }
  }
  const connectionHostId = connectionId ? toSshExecutionHostId(connectionId) : null
  if (explicitHost && connectionHostId && explicitHost.id !== connectionHostId) {
    return { status: 'contradictory' }
  }
  return {
    status: 'owned',
    hostId: explicitHost?.id ?? connectionHostId ?? LOCAL_EXECUTION_HOST_ID
  }
}

export function findExactRepoOwner(
  store: Store,
  repoId: string,
  executionHostId?: ExecutionHostId
): Repo | undefined {
  const candidates = store.getRepos().filter((repo) => repo.id === repoId)
  const evidence = candidates.map(resolveRepoOwnershipEvidence)
  if (evidence.some((owner) => owner.status !== 'owned')) {
    return undefined
  }
  const matches = candidates.filter((_, index) => {
    const owner = evidence[index]
    return (
      owner?.status === 'owned' &&
      (executionHostId === undefined || owner.hostId === executionHostId)
    )
  })
  return matches.length === 1 ? matches[0] : undefined
}

export function isCapturedRepoCurrent(
  store: Store,
  repo: Repo,
  executionHostId?: ExecutionHostId
): boolean {
  const current = findExactRepoOwner(store, repo.id, executionHostId)
  return (
    current !== undefined &&
    current.path === repo.path &&
    (current.connectionId ?? null) === (repo.connectionId ?? null) &&
    (current.executionHostId ?? null) === (repo.executionHostId ?? null)
  )
}
