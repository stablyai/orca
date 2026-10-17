import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { RemovedRepoIdTombstone } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'

// Why: bound removal history so remove/re-add churn can't grow the file unbounded.
export const MAX_REMOVED_REPO_ID_TOMBSTONES = 512

type RepoRegistrationTarget = Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>

function tombstoneMatches(
  tombstone: RemovedRepoIdTombstone,
  hostId: ExecutionHostId,
  pathKey: string
): boolean {
  return tombstone.hostId === hostId && tombstone.pathKey === pathKey
}

/** Newest last; a later removal of the same host + path replaces the earlier one. */
export function recordRemovedRepoIdTombstone(
  tombstones: readonly RemovedRepoIdTombstone[],
  repo: Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'>,
  removedAt: number
): RemovedRepoIdTombstone[] {
  const hostId = getRepoExecutionHostId(repo)
  const pathKey = normalizeRuntimePathForComparison(repo.path)
  if (!pathKey) {
    return [...tombstones]
  }
  const next = tombstones.filter((tombstone) => !tombstoneMatches(tombstone, hostId, pathKey))
  next.push({ repoId: repo.id, hostId, pathKey, removedAt })
  return next.slice(-MAX_REMOVED_REPO_ID_TOMBSTONES)
}

/** The id the same folder on the same host had before it was removed, and the list without it. */
export function claimRemovedRepoIdTombstone(
  tombstones: readonly RemovedRepoIdTombstone[],
  target: RepoRegistrationTarget
): { repoId: string; remaining: RemovedRepoIdTombstone[] } | null {
  const hostId = getRepoExecutionHostId(target)
  const pathKey = normalizeRuntimePathForComparison(target.path)
  const claimed = tombstones.find((tombstone) => tombstoneMatches(tombstone, hostId, pathKey))
  if (!pathKey || !claimed) {
    return null
  }
  return {
    repoId: claimed.repoId,
    remaining: tombstones.filter((tombstone) => tombstone !== claimed)
  }
}

export function normalizeRemovedRepoIdTombstones(value: unknown): RemovedRepoIdTombstone[] {
  if (!Array.isArray(value)) {
    return []
  }
  const normalized: RemovedRepoIdTombstone[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const { repoId, hostId, pathKey, removedAt }: Record<string, unknown> = { ...entry }
    const normalizedHostId = typeof hostId === 'string' ? normalizeExecutionHostId(hostId) : null
    if (
      typeof repoId !== 'string' ||
      !repoId ||
      !normalizedHostId ||
      typeof pathKey !== 'string' ||
      !pathKey ||
      typeof removedAt !== 'number' ||
      !Number.isFinite(removedAt)
    ) {
      continue
    }
    normalized.push({ repoId, hostId: normalizedHostId, pathKey, removedAt })
  }
  return normalized.slice(-MAX_REMOVED_REPO_ID_TOMBSTONES)
}
