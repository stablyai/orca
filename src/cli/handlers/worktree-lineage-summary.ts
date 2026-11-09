import type { RuntimeWorktreeCreateResult, RuntimeWorktreeRecord } from '../../shared/runtime-types'

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

/**
 * The stderr parent summary for create/set: the `ps` parent text plus how the parent was captured.
 * `parentText` comes from the result's annotation; without one, a cross-store parent's server is unknown.
 */
function parentSummaryText(
  parentText: string | null,
  fallback: string,
  capture: { confidence: string; source: string }
): string {
  return `parent: ${parentText ?? fallback} (${capture.confidence} from ${getLineageSourceLabel(capture.source)})`
}

/** The parent `worktree set` attached; same-store lineage fields stay null for both kinds. */
export function printSetParentLine(
  worktree: RuntimeWorktreeRecord,
  parentFields: { crossStoreParent?: unknown; parentWorktree?: string },
  parentText: string | null
): void {
  if (parentFields.crossStoreParent && worktree.crossStoreLineage) {
    const { parent, capture } = worktree.crossStoreLineage
    console.error(parentSummaryText(parentText, crossStoreFallback(parent.workspaceKey), capture))
  } else if (parentFields.parentWorktree && worktree.workspaceLineage) {
    const { parentWorkspaceKey, capture } = worktree.workspaceLineage
    console.error(parentSummaryText(parentText, parentWorkspaceKey, capture))
  }
}

function crossStoreFallback(workspaceKey: string): string {
  return `${workspaceKey}  server=unknown (no verified route here)`
}

export function printLineageSummary(
  result: Pick<RuntimeWorktreeCreateResult, 'lineage' | 'workspaceLineage'> &
    Partial<Pick<RuntimeWorktreeCreateResult, 'warnings' | 'crossStoreLineage'>>,
  json: boolean,
  parentText: string | null = null
): void {
  if (json) {
    return
  }
  for (const warning of result.warnings ?? []) {
    console.error(`warning: ${warning.message}`)
  }
  if (result.crossStoreLineage) {
    const { parent, capture } = result.crossStoreLineage
    console.error(parentSummaryText(parentText, crossStoreFallback(parent.workspaceKey), capture))
    return
  }
  if (result.workspaceLineage) {
    const { parentWorkspaceKey, capture } = result.workspaceLineage
    console.error(parentSummaryText(parentText, parentWorkspaceKey, capture))
    return
  }
  if (result.lineage) {
    const { parentWorktreeId, capture } = result.lineage
    console.error(parentSummaryText(parentText, `id:${parentWorktreeId}`, capture))
    return
  }
  console.error('parent: none')
}
