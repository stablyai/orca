import type { RuntimeWorktreeCreateResult } from '../../shared/runtime-types'

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

export function printLineageSummary(
  result: Pick<RuntimeWorktreeCreateResult, 'lineage' | 'workspaceLineage'> &
    Partial<Pick<RuntimeWorktreeCreateResult, 'warnings'>>,
  json: boolean
): void {
  if (json) {
    return
  }
  for (const warning of result.warnings ?? []) {
    console.error(`warning: ${warning.message}`)
  }
  if (result.workspaceLineage) {
    const { parentWorkspaceKey, capture, parentStore } = result.workspaceLineage
    console.error(
      `parent: ${parentWorkspaceKey}${parentStore ? ' (parent on another machine)' : ''} (${capture.confidence} from ${getLineageSourceLabel(capture.source)})`
    )
    return
  }
  if (result.lineage) {
    const { parentWorktreeId, capture, parentStore } = result.lineage
    console.error(
      `parent: ${parentWorktreeId}${parentStore ? ' (parent on another machine)' : ''} (${capture.confidence} from ${getLineageSourceLabel(capture.source)})`
    )
    return
  }
  console.error('parent: none')
}
