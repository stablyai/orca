import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { Repo, WorkspaceKey } from '../../shared/types'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { WORKTREE_ID_SEPARATOR } from '../../shared/worktree-id'

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
  if (isRepoWorktreeId(oldRepoId, ownerKey)) {
    return rekeyWorktreeId(oldRepoId, newRepoId, ownerKey)
  }
  const parsed = parseWorkspaceKey(ownerKey)
  if (parsed?.type === 'worktree' && isRepoWorktreeId(oldRepoId, parsed.worktreeId)) {
    return worktreeWorkspaceKey(rekeyWorktreeId(oldRepoId, newRepoId, parsed.worktreeId))
  }
  return null
}

export function ownerKeyBelongsToRepo(ownerKey: string, repoId: string): boolean {
  if (isRepoWorktreeId(repoId, ownerKey)) {
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
