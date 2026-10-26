import { getRepoExecutionHostId, type ExecutionHostId } from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'

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
