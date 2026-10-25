import type { DiffComment } from '../shared/diff-comment-types'
import type { FolderWorkspace } from '../shared/folder-workspace-types'

// Preserve members without filtering so normalization cannot delete user-authored comments.
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

// Rebuilding on write drops stale entries without separate pruning on deletion.
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
