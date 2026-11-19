import { isFolderRepo } from '../../../shared/repository/repo-kind'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import type { Repo } from '../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'

export type WorktreeRemovalRepoSource = {
  getRepos: () => readonly Repo[]
  getRepo: (repoId: string) => Repo | undefined
}

export type WorktreeRemovalRepoOwner =
  | { kind: 'resolved'; repo: Repo }
  | { kind: 'ambiguous' }
  | { kind: 'missing' }

/** Legacy callers may omit hostId only when the repo has one unambiguous owner. */
export function resolveWorktreeRemovalRepoOwner(
  store: WorktreeRemovalRepoSource,
  repoId: string,
  hostId?: ExecutionHostId
): WorktreeRemovalRepoOwner {
  const matches = store
    .getRepos()
    .filter((repo) => repo.id === repoId && (!hostId || getRepoExecutionHostId(repo) === hostId))
  if (matches.length === 1 && matches[0]) {
    return { kind: 'resolved', repo: matches[0] }
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous' }
  }
  const legacyMatch = store.getRepo(repoId)
  return legacyMatch && (!hostId || getRepoExecutionHostId(legacyMatch) === hostId)
    ? { kind: 'resolved', repo: legacyMatch }
    : { kind: 'missing' }
}

/** Conservatively preserve process state for any other host's repo copy, even if no same-ID worktree is known. */
export function hasWorktreeRemovalRepoOwnerOnOtherHost(
  store: Pick<WorktreeRemovalRepoSource, 'getRepos'>,
  repoId: string,
  hostId: ExecutionHostId
): boolean {
  return store
    .getRepos()
    .some((repo) => repo.id === repoId && getRepoExecutionHostId(repo) !== hostId)
}

export function resolveWorktreeRemovalMetadata(
  store: Pick<WorktreeRemovalRepoSource, 'getRepos'> & {
    getWorktreeMeta: (worktreeId: string) => WorktreeMeta | undefined
  },
  repoId: string,
  worktreeId: string,
  hostId: ExecutionHostId
): WorktreeMeta | undefined {
  const meta = store.getWorktreeMeta(worktreeId)
  if (!meta) {
    return undefined
  }
  const repoOwnerCount = store.getRepos().filter((repo) => repo.id === repoId).length
  if (repoOwnerCount <= 1) {
    return meta
  }
  return meta.hostId === hostId ? meta : undefined
}

export function resolveUnambiguousWorktreeRemovalRepo(
  store: WorktreeRemovalRepoSource,
  target: { repoId: string; id: string },
  hostId: ExecutionHostId | undefined,
  requireGit: boolean
): { repo: Repo | undefined; hostId: ExecutionHostId | undefined } {
  const owner = resolveWorktreeRemovalRepoOwner(store, target.repoId, hostId)
  if (owner.kind === 'ambiguous') {
    throw new Error(
      `Workspace identity is ambiguous across hosts: ${target.id}. Retry with an explicit host.`
    )
  }
  const repo = owner.kind === 'resolved' ? owner.repo : undefined
  if (requireGit && (!repo || isFolderRepo(repo))) {
    throw new Error('The reviewed Git workspace is no longer registered.')
  }
  return { repo, hostId: repo ? (hostId ?? getRepoExecutionHostId(repo)) : hostId }
}

export function resolveLocalWorktreeRemovalRepo(
  store: WorktreeRemovalRepoSource,
  repoId: string
): Repo | undefined {
  const owner = resolveWorktreeRemovalRepoOwner(store, repoId, LOCAL_EXECUTION_HOST_ID)
  return owner.kind === 'resolved' ? owner.repo : undefined
}
