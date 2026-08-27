import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceKey } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { WORKTREE_ID_SEPARATOR } from '../../shared/worktree/id'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../shared/worktree/host-qualified-identity'

export function repoPhysicalKey(
  repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>
): string {
  return [
    getRepoExecutionHostId(repo),
    repo.connectionId?.trim() ?? '',
    normalizeRuntimePathForComparison(repo.path)
  ].join('\0')
}

export function isRepoWorktreeId(repoId: string, worktreeId: string): boolean {
  return worktreeId === repoId || worktreeId.startsWith(`${repoId}${WORKTREE_ID_SEPARATOR}`)
}

export function rekeyWorktreeId(oldRepoId: string, newRepoId: string, worktreeId: string): string {
  if (worktreeId === oldRepoId) {
    return newRepoId
  }
  const prefix = `${oldRepoId}${WORKTREE_ID_SEPARATOR}`
  return worktreeId.startsWith(prefix)
    ? `${newRepoId}${WORKTREE_ID_SEPARATOR}${worktreeId.slice(prefix.length)}`
    : worktreeId
}

export function rekeyWorkspaceKey(
  oldRepoId: string,
  newRepoId: string,
  workspaceKey: WorkspaceKey
): WorkspaceKey {
  const parsed = parseWorkspaceKey(workspaceKey)
  if (parsed?.type !== 'worktree' || !isRepoWorktreeId(oldRepoId, parsed.worktreeId)) {
    return workspaceKey
  }
  return worktreeWorkspaceKey(rekeyWorktreeId(oldRepoId, newRepoId, parsed.worktreeId))
}

export function rekeyOwnerKey(
  oldRepoId: string,
  newRepoId: string,
  ownerKey: string
): string | null {
  const rawOwnerKey = isWorktreeHostIdentity(ownerKey)
    ? getWorktreeIdFromHostIdentity(ownerKey)
    : ownerKey
  if (isRepoWorktreeId(oldRepoId, rawOwnerKey)) {
    const rekeyed = rekeyWorktreeId(oldRepoId, newRepoId, rawOwnerKey)
    return isWorktreeHostIdentity(ownerKey)
      ? `${ownerKey.slice(0, ownerKey.length - rawOwnerKey.length)}${rekeyed}`
      : rekeyed
  }
  const parsed = parseWorkspaceKey(ownerKey)
  if (parsed?.type === 'worktree' && isRepoWorktreeId(oldRepoId, parsed.worktreeId)) {
    return worktreeWorkspaceKey(rekeyWorktreeId(oldRepoId, newRepoId, parsed.worktreeId))
  }
  return null
}

export function ownerKeyBelongsToRepo(ownerKey: string, repoId: string): boolean {
  const rawOwnerKey = isWorktreeHostIdentity(ownerKey)
    ? getWorktreeIdFromHostIdentity(ownerKey)
    : ownerKey
  if (isRepoWorktreeId(repoId, rawOwnerKey)) {
    return true
  }
  const parsed = parseWorkspaceKey(ownerKey)
  return parsed?.type === 'worktree' && isRepoWorktreeId(repoId, parsed.worktreeId)
}

export function removeRepoWorktreeRecord<T>(
  record: Record<string, T> | undefined,
  repoId: string
): Record<string, T> {
  const next = { ...record }
  for (const key of Object.keys(next)) {
    if (ownerKeyBelongsToRepo(key, repoId)) {
      delete next[key]
    }
  }
  return next
}
