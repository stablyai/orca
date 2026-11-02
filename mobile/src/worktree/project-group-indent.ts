import type { Worktree } from './workspace-list-types'

// Match desktop indentation.ts steps and its six-level cap.
const PROJECT_GROUP_HEADER_INDENT = 10
const TREE_INDENT = 18
const MAX_PROJECT_GROUP_DEPTH = 6

function cappedDepth(depth: number | undefined): number {
  return Math.min(Math.max(0, Math.floor(depth ?? 0)), MAX_PROJECT_GROUP_DEPTH)
}

export function projectGroupHeaderIndent(depth: number | undefined): number {
  return cappedDepth(depth) * PROJECT_GROUP_HEADER_INDENT
}

// Match desktop row indentation; folder-scan groups use the header step and folder workspaces sit one level shallower.
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
