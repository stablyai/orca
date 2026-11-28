import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'

function countRepoOwners(repos: readonly Repo[], repoId: string): number {
  let count = 0
  for (const candidate of repos) {
    if (candidate.id === repoId) {
      count += 1
    }
  }
  return count
}

export function hasConflictingStoredWorktreeOwner(
  store: Store,
  repo: Repo,
  worktreeIds: readonly string[]
): boolean {
  if (worktreeIds.length === 0) {
    return false
  }
  const expectedHostId = getRepoExecutionHostId(repo)
  const repoOwnerCount = countRepoOwners(store.getRepos(), repo.id)
  for (const worktreeId of worktreeIds) {
    const meta = store.getWorktreeMeta(worktreeId)
    if (meta && (meta.hostId ? meta.hostId !== expectedHostId : repoOwnerCount > 1)) {
      return true
    }
  }
  return false
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
  let matched: Repo | undefined
  let matchCount = 0
  for (const candidate of store.getRepos()) {
    if (candidate.id !== repoId) {
      continue
    }
    const owner = resolveRepoOwnershipEvidence(candidate)
    if (owner.status !== 'owned') {
      return undefined
    }
    if (executionHostId === undefined || owner.hostId === executionHostId) {
      matched = candidate
      matchCount += 1
    }
  }
  return matchCount === 1 ? matched : undefined
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
