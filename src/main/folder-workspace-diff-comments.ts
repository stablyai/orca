import type { DiffComment, FolderWorkspace } from '../shared/types'

// Why shape-only: this replaces folder-workspaces.ts's verbatim `Array.isArray(raw.diffComments)` read.
// Filtering members would make the fix itself a new deletion path for user-authored prose.
export function normalizeFolderWorkspaceDiffComments(
  value: unknown
): Record<string, DiffComment[]> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const normalized: Record<string, DiffComment[]> = {}
  let kept = false
  for (const [id, comments] of Object.entries(value)) {
    if (!Array.isArray(comments)) {
      continue
    }
    normalized[id] = comments as DiffComment[]
    kept = true
  }
  return kept ? normalized : undefined
}

// Why derive on every write: the map self-GCs, so delete paths need no pruning code.
export function collectFolderWorkspaceDiffComments(
  workspaces: readonly FolderWorkspace[] | undefined
): Record<string, DiffComment[]> | undefined {
  const collected: Record<string, DiffComment[]> = {}
  let kept = false
  for (const workspace of workspaces ?? []) {
    const comments = workspace.diffComments
    if (Array.isArray(comments) && comments.length > 0) {
      collected[workspace.id] = comments
      kept = true
    }
  }
  return kept ? collected : undefined
}
