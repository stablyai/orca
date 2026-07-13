import type {
  NewWorkspaceSourceFilter,
  NewWorkspaceSourceRow
} from '../workspace-source/new-workspace-source-types'

export function workspaceSourceFilterLabel(filter: NewWorkspaceSourceFilter): string {
  return filter === 'all'
    ? 'All'
    : filter === 'github'
      ? 'GitHub'
      : filter === 'branches'
        ? 'Branches'
        : 'Linear'
}

export function workspaceSourceTitle(row: NewWorkspaceSourceRow): string {
  return row.kind === 'github'
    ? row.item.title
    : row.kind === 'linear'
      ? row.issue.title
      : row.refName
}

export function workspaceSourceSubtitle(row: NewWorkspaceSourceRow): string {
  return row.kind === 'github'
    ? `${row.item.type === 'pr' ? 'PR' : 'Issue'} #${row.item.number}`
    : row.kind === 'linear'
      ? row.issue.identifier
      : row.verified
        ? 'Branch or ref'
        : 'Branch or ref · reuse unavailable'
}

export function workspaceSourceAccessibilityLabel(row: NewWorkspaceSourceRow): string {
  return `${workspaceSourceSubtitle(row)}, ${workspaceSourceTitle(row)}`
}
