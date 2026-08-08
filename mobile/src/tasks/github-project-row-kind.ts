/** The slice of a GitHub Projects row its kind can be decided from. */
export type GitHubProjectRowKindSource = {
  itemType: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE' | 'REDACTED'
  content: {
    number: number | null
    url: string | null
  }
}

export function projectRowType(row: GitHubProjectRowKindSource): 'issue' | 'pr' | null {
  if (row.itemType === 'ISSUE') {
    return 'issue'
  }
  if (row.itemType === 'PULL_REQUEST') {
    return 'pr'
  }
  return null
}

// Why: desktop only exposes Project "Start work" for backed issue/PR rows
// with enough GitHub identity to build the linked work item.
export function canCreateWorkspaceFromProjectRow(row: GitHubProjectRowKindSource): boolean {
  return projectRowType(row) !== null && row.content.number != null && Boolean(row.content.url)
}
