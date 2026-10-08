import {
  assignHydratedEditorFileIds,
  type HydratedEditorFileIdAssignment
} from '../../shared/editor-file-identity'
import type { PersistedOpenFile } from '../../shared/workspace-session-state-types'

type HydratedAssignmentsCacheEntry = {
  rowsByWorktree: Map<string, { rows: readonly PersistedOpenFile[]; length: number }>
  assignmentsByWorktree: Map<string, HydratedEditorFileIdAssignment[]>
}

// Why: ids depend on every partition row, and each hydrate pass asks once per worktree.
const hydratedAssignmentsCache = new WeakMap<object, HydratedAssignmentsCacheEntry>()

// Why the row check: a worktree rename re-keys the stored map in place.
function cacheEntryMatches(
  entry: HydratedAssignmentsCacheEntry,
  openFilesByWorktree: Record<string, readonly PersistedOpenFile[]>
): boolean {
  const keys = Object.keys(openFilesByWorktree)
  return (
    keys.length === entry.rowsByWorktree.size &&
    keys.every((key) => {
      const rows = openFilesByWorktree[key]!
      const cached = entry.rowsByWorktree.get(key)
      return cached?.rows === rows && cached.length === rows.length
    })
  )
}

export function hydratedAssignmentsForWorktree(
  openFilesByWorktree: Record<string, readonly PersistedOpenFile[]> | undefined,
  worktreeId: string
): HydratedEditorFileIdAssignment[] {
  if (!openFilesByWorktree?.[worktreeId]?.length) {
    return []
  }
  let entry = hydratedAssignmentsCache.get(openFilesByWorktree)
  if (!entry || !cacheEntryMatches(entry, openFilesByWorktree)) {
    entry = {
      rowsByWorktree: new Map(
        Object.entries(openFilesByWorktree).map(([key, rows]) => [
          key,
          { rows, length: rows.length }
        ])
      ),
      assignmentsByWorktree: new Map()
    }
    for (const assignment of assignHydratedEditorFileIds(openFilesByWorktree)) {
      const list = entry.assignmentsByWorktree.get(assignment.worktreeId)
      if (list) {
        list.push(assignment)
      } else {
        entry.assignmentsByWorktree.set(assignment.worktreeId, [assignment])
      }
    }
    hydratedAssignmentsCache.set(openFilesByWorktree, entry)
  }
  return entry.assignmentsByWorktree.get(worktreeId) ?? []
}
