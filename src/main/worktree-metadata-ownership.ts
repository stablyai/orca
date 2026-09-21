import { getRepoExecutionHostId } from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'

/** Same repo/worktree ids can exist on several hosts; bare metadata cannot choose between them. */
export function getRepoOwnedWorktreeMeta(
  repo: Repo,
  worktreeId: string,
  metaById: Readonly<Record<string, WorktreeMeta>>,
  repoOwnerCount: number
): WorktreeMeta | undefined {
  const existingMeta = metaById[worktreeId]
  return isWorktreeMetaOwnedByRepo(repo, existingMeta, repoOwnerCount) ? existingMeta : undefined
}

export function isWorktreeMetaOwnedByRepo(
  repo: Repo,
  meta: WorktreeMeta | undefined,
  repoOwnerCount: number
): meta is WorktreeMeta {
  return Boolean(meta && (repoOwnerCount === 1 || meta.hostId === getRepoExecutionHostId(repo)))
}
