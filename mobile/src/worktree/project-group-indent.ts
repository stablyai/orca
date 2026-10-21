import type { Worktree } from './workspace-list-types'

// The desktop's project-group tree steps (indentation.ts): headers 10 px a level, workspace cards a
// full 18 px tree step; capped at six levels, as the headers are.
const PROJECT_GROUP_HEADER_INDENT = 10
const TREE_INDENT = 18
const MAX_PROJECT_GROUP_DEPTH = 6

function cappedDepth(depth: number | undefined): number {
  return Math.min(Math.max(0, Math.floor(depth ?? 0)), MAX_PROJECT_GROUP_DEPTH)
}

/** A header's indent past the phone's base padding, for its depth in the group tree. */
export function projectGroupHeaderIndent(depth: number | undefined): number {
  return cappedDepth(depth) * PROJECT_GROUP_HEADER_INDENT
}

/**
 * A row's indent past the phone's base padding: what the desktop adds over an ungrouped card. A
 * folder-scanned group's rows take the header step, its folder workspaces one level less.
 */
export function projectGroupRowIndent(
  row: Pick<Worktree, 'workspaceKind' | 'projectGroupDepth' | 'inFolderScanGroup'>
): number {
  const depth = row.projectGroupDepth ?? 0
  if (!row.inFolderScanGroup) {
    return cappedDepth(depth) * TREE_INDENT
  }
  return row.workspaceKind === 'folder-workspace'
    ? cappedDepth(depth - 1) * PROJECT_GROUP_HEADER_INDENT
    : cappedDepth(depth) * PROJECT_GROUP_HEADER_INDENT
}
