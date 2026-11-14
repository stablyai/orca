import type {
  RuntimeWorktreeCreateResult,
  RuntimeWorktreeRecord
} from '../../shared/runtime-worktree-contracts'

function getLineageSourceLabel(source: string): string {
  switch (source) {
    case 'terminal-context':
      return 'terminal'
    case 'cwd-context':
      return 'cwd'
    case 'orchestration-context':
      return 'orchestration'
    case 'env-workspace':
      return 'environment'
    case 'explicit-cli-flag':
      return 'explicit flag'
    case 'active-workspace':
      return 'active context'
    default:
      return 'manual action'
  }
}

/** The summary line for a parent saved in another Orca store. */
export function formatCrossStoreParentLine(
  lineage: NonNullable<RuntimeWorktreeCreateResult['crossStoreLineage']>
): string {
  return `parent: ${lineage.parent.workspaceKey} on another machine (${lineage.capture.confidence} from ${getLineageSourceLabel(lineage.capture.source)})`
}

export function formatFolderParentLine(
  lineage: NonNullable<RuntimeWorktreeCreateResult['workspaceLineage']>
): string {
  return `parent: ${lineage.parentWorkspaceKey} (folder workspace)`
}

/** The parent `worktree set` attached; same-store lineage fields stay null for both kinds. */
export function printSetParentLine(
  worktree: RuntimeWorktreeRecord,
  parentFields: { crossStoreParent?: unknown; parentWorktree?: string }
): void {
  if (parentFields.crossStoreParent && worktree.crossStoreLineage) {
    console.error(formatCrossStoreParentLine(worktree.crossStoreLineage))
  } else if (parentFields.parentWorktree && worktree.workspaceLineage) {
    console.error(formatFolderParentLine(worktree.workspaceLineage))
  }
}

export function printLineageSummary(
  result: Pick<RuntimeWorktreeCreateResult, 'lineage' | 'workspaceLineage'> &
    Partial<Pick<RuntimeWorktreeCreateResult, 'warnings' | 'crossStoreLineage'>>,
  json: boolean
): void {
  if (json) {
    return
  }
  for (const warning of result.warnings ?? []) {
    console.error(`warning: ${warning.message}`)
  }
  if (result.crossStoreLineage) {
    console.error(formatCrossStoreParentLine(result.crossStoreLineage))
    return
  }
  if (result.workspaceLineage) {
    const { parentWorkspaceKey, capture } = result.workspaceLineage
    console.error(
      `parent: ${parentWorkspaceKey} (${capture.confidence} from ${getLineageSourceLabel(capture.source)})`
    )
    return
  }
  if (result.lineage) {
    const { parentWorktreeId, capture } = result.lineage
    console.error(
      `parent: ${parentWorktreeId} (${capture.confidence} from ${getLineageSourceLabel(capture.source)})`
    )
    return
  }
  console.error('parent: none')
}
