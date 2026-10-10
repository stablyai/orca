import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoKind } from '../../../../shared/repo-kind'
import { getWorktreeScanMutationRevision } from '../../../local-worktree-scan-generation'

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
  store: Pick<Store, 'getRepos'>,
  repoId: string,
  executionHostId?: ExecutionHostId
): Repo | undefined {
  const candidates = store.getRepos().filter((repo) => repo.id === repoId)
  return findExactOwner(candidates, executionHostId)
}

export function resolveRepoForConnection(
  selectors: {
    resolveRepo(selector: string): Promise<Repo>
    selectRepos(selector: string): Repo[]
  },
  selector: string,
  connectionId?: string | null
): Promise<Repo> {
  if (connectionId === undefined) {
    return selectors.resolveRepo(selector)
  }
  const wanted = connectionId?.trim() || null
  const matches = selectors
    .selectRepos(selector)
    .filter((repo) => (repo.connectionId?.trim() || null) === wanted)
  if (matches.length !== 1) {
    throw new Error(matches.length > 1 ? 'selector_ambiguous' : 'repo_not_found')
  }
  return Promise.resolve(matches[0])
}

function findExactOwner(
  candidates: readonly Repo[],
  executionHostId?: ExecutionHostId
): Repo | undefined {
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
  store: Pick<Store, 'getRepos'>,
  repo: Repo,
  executionHostId?: ExecutionHostId
): boolean {
  const current = findExactRepoOwner(store, repo.id, executionHostId)
  return matchesCapturedRegistration(current, repo)
}

function matchesCapturedRegistration(current: Repo | undefined, repo: Repo): boolean {
  return (
    current !== undefined &&
    current.path === repo.path &&
    current.addedAt === repo.addedAt &&
    getRepoKind(current) === getRepoKind(repo) &&
    (current.connectionId ?? null) === (repo.connectionId ?? null) &&
    (current.executionHostId ?? null) === (repo.executionHostId ?? null)
  )
}

export type CapturedRepoCurrentGuard = (repo: Repo, executionHostId?: ExecutionHostId) => boolean

/** Batch readers share one catalog index; metadata stamping does not advance its mutation witness. */
export function createCapturedRepoCurrentGuard(
  store: Pick<Store, 'getRepos'>,
  initialRepos?: readonly Repo[]
): CapturedRepoCurrentGuard {
  let revision = getWorktreeScanMutationRevision()
  let owners = indexRepoOwners(initialRepos ?? store.getRepos())
  return (repo, executionHostId) => {
    const currentRevision = getWorktreeScanMutationRevision()
    if (revision !== currentRevision) {
      owners = indexRepoOwners(store.getRepos())
      revision = currentRevision
    }
    return matchesCapturedRegistration(
      findExactOwner(owners.get(repo.id) ?? [], executionHostId),
      repo
    )
  }
}

function indexRepoOwners(repos: readonly Repo[]): Map<string, Repo[]> {
  const owners = new Map<string, Repo[]>()
  for (const repo of repos) {
    const candidates = owners.get(repo.id) ?? []
    candidates.push({ ...repo })
    owners.set(repo.id, candidates)
  }
  return owners
}
