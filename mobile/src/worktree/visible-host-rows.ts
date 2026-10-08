import {
  normalizeVisibleExecutionHostIds,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import type { Worktree } from './workspace-list-types'
import { resolveWorktreeHostId } from './worktree-host-context-labels'

/** The hosts the desktop's sidebar shows, mirrored exactly; null shows every host. */
export function readVisibleHostIds(
  value: readonly string[] | null | undefined
): ReadonlySet<ExecutionHostId> | null {
  const ids = normalizeVisibleExecutionHostIds(value)
  return ids ? new Set(ids) : null
}

export function filterVisibleHostRows(
  rows: readonly Worktree[],
  visibleHostIds: ReadonlySet<ExecutionHostId> | null,
  repoHostIdByRepoId: ReadonlyMap<string, ExecutionHostId>
): Worktree[] {
  if (!visibleHostIds) {
    return [...rows]
  }
  return rows.filter((row) => visibleHostIds.has(resolveWorktreeHostId(row, repoHostIdByRepoId)))
}
