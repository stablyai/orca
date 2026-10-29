type WorktreeSetTrackerLinks = {
  linkedLinearIssue?: string | null
  linkedLinearIssueWorkspaceId?: string | null
  linkedLinearIssueOrganizationUrlKey?: string | null
  linkedClickUpTaskId?: string | null
  linkedClickUpWorkspaceId?: string | null
}

/** Linear and ClickUp links travel as legacy meta fields; undefined leaves the stored link untouched. */
export function pickWorktreeSetTrackerLinks(
  params: WorktreeSetTrackerLinks
): WorktreeSetTrackerLinks {
  return {
    linkedLinearIssue: params.linkedLinearIssue,
    linkedLinearIssueWorkspaceId: params.linkedLinearIssueWorkspaceId,
    linkedLinearIssueOrganizationUrlKey: params.linkedLinearIssueOrganizationUrlKey,
    linkedClickUpTaskId: params.linkedClickUpTaskId,
    linkedClickUpWorkspaceId: params.linkedClickUpWorkspaceId
  }
}
