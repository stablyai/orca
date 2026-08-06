type GitHubProjectFieldState = {
  id: string
  dataType: string
}

type GitHubProjectFieldValueState = {
  kind: string
  text?: string
  labels?: readonly unknown[]
  users?: readonly unknown[]
}

type GitHubProjectRowState = {
  content: {
    assignees: readonly unknown[]
    labels: readonly unknown[]
    repository: string | null
    parentIssue?: unknown
    issueType?: unknown
  }
  fieldValuesByFieldId?: Readonly<Record<string, GitHubProjectFieldValueState>>
}

export function isGitHubProjectFieldEmpty(
  row: GitHubProjectRowState,
  field: GitHubProjectFieldState
): boolean {
  if (field.dataType === 'ASSIGNEES') {
    return row.content.assignees.length === 0
  }
  if (field.dataType === 'LABELS') {
    return row.content.labels.length === 0
  }
  if (field.dataType === 'REPOSITORY') {
    return row.content.repository === null
  }
  if (field.dataType === 'PARENT_ISSUE') {
    return row.content.parentIssue == null
  }
  if (field.dataType === 'ISSUE_TYPE') {
    return row.content.issueType == null
  }
  if (field.dataType === 'TITLE') {
    return false
  }

  const value = row.fieldValuesByFieldId?.[field.id]
  if (!value) {
    return true
  }
  if (value.kind === 'text') {
    return !value.text
  }
  if (value.kind === 'labels') {
    return !value.labels?.length
  }
  if (value.kind === 'users') {
    return !value.users?.length
  }
  return false
}
