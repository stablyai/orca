import type { Worktree } from '../worktree/workspace-list-types'
import { isSameWorktreeRow } from '../worktree/worktree-host-row-identity'

/**
 * What a Worktree Settings save sends as `displayName`, or null when nothing changed.
 *
 * Mirrors the desktop's Display Name field (WorktreeMetaDialogDraft): the field opens on the name
 * the sidebar shows, a save writes only when the trimmed text differs, and empty text is a real
 * write — the host's blanking contract that returns the label to the branch name.
 */
export function worktreeDisplayNameUpdate(current: string, draft: string): string | null {
  const next = draft.trim()
  return next === current.trim() ? null : next
}

/**
 * The label the host derives once a custom name is cleared: main's `mergeWorktree` falls back to
 * the branch, then the folder. Only the row shown right after the save reads this; the next
 * refresh brings the host's own.
 */
export function automaticWorktreeDisplayName(
  item: Pick<Worktree, 'branch' | 'path' | 'repo'>
): string {
  const branch = (item.branch ?? '').replace(/^refs\/heads\//, '').trim()
  if (branch) {
    return branch
  }
  const folder = (item.path ?? '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop()
    ?.trim()
  return folder || item.repo
}

/** The list with only `target`'s row relabelled; a same-id row on another host keeps its name. */
export function renamedWorktreeRows(
  list: readonly Worktree[],
  target: Pick<Worktree, 'worktreeId' | 'hostId'>,
  displayName: string
): Worktree[] {
  return list.map((row) => (isSameWorktreeRow(row, target) ? { ...row, displayName } : row))
}
