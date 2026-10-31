import type {
  JiraComment,
  JiraCreateIssueResult,
  JiraEditField,
  JiraEditFieldValue,
  JiraIssue,
  JiraPriority,
  JiraProject,
  JiraIssueType,
  JiraTransition,
  JiraUser
} from '../shared/jira/jira-types'

function issueHeadline(issue: JiraIssue): string {
  return `${issue.key} ${issue.title}`
}

export function formatJiraIssue(issue: JiraIssue): string {
  const lines = [
    issueHeadline(issue),
    `URL: ${issue.url}`,
    `Status: ${issue.status.name} (${issue.status.categoryName})`,
    `Type: ${issue.issueType.name}`,
    `Project: ${issue.project.key} ${issue.project.name}`,
    `Assignee: ${issue.assignee?.displayName ?? 'unassigned'}`,
    `Reporter: ${issue.reporter?.displayName ?? 'unknown'}`,
    `Priority: ${issue.priority?.name ?? 'none'}`
  ]
  if (issue.labels.length > 0) {
    lines.push(`Labels: ${issue.labels.join(', ')}`)
  }
  if (issue.siteName) {
    lines.push(`Site: ${issue.siteName}`)
  }
  lines.push(`Updated: ${issue.updatedAt}`)
  if (issue.description) {
    lines.push('', issue.description)
  }
  return lines.join('\n')
}

export function formatJiraIssueList(issues: JiraIssue[]): string {
  if (issues.length === 0) {
    return 'No issues.'
  }
  return issues
    .map(
      (issue) =>
        `${issue.key}\t${issue.status.name}\t${issue.assignee?.displayName ?? 'unassigned'}\t${issue.title}`
    )
    .join('\n')
}

export function formatJiraProjectList(projects: JiraProject[]): string {
  if (projects.length === 0) {
    return 'No projects.'
  }
  return projects.map((project) => `${project.key}\t${project.id}\t${project.name}`).join('\n')
}

export function formatJiraIssueTypeList(issueTypes: JiraIssueType[]): string {
  if (issueTypes.length === 0) {
    return 'No issue types.'
  }
  return issueTypes
    .map((type) => `${type.id}\t${type.name}${type.subtask ? '\t(subtask)' : ''}`)
    .join('\n')
}

export function formatJiraTransitionList(transitions: JiraTransition[]): string {
  if (transitions.length === 0) {
    return 'No available transitions.'
  }
  return transitions
    .map((transition) => `${transition.id}\t${transition.name}\t→ ${transition.to.name}`)
    .join('\n')
}

export function formatJiraPriorityList(priorities: JiraPriority[]): string {
  if (priorities.length === 0) {
    return 'No priorities.'
  }
  return priorities.map((priority) => `${priority.id}\t${priority.name}`).join('\n')
}

export function formatJiraUserList(users: JiraUser[]): string {
  if (users.length === 0) {
    return 'No assignable users.'
  }
  return users.map((user) => `${user.accountId}\t${user.displayName}`).join('\n')
}

function editFieldValueText(value: JiraEditFieldValue): string {
  switch (value.kind) {
    case 'empty':
      return '-'
    case 'text': {
      const [first, ...rest] = value.text.trim().split('\n')
      return rest.length > 0 ? `${first}…` : first
    }
    case 'options':
      return value.options.map((option) => option.name ?? option.value ?? option.id).join(', ')
    case 'users':
      return value.users.map((user) => user.displayName).join(', ')
    case 'strings':
      return value.values.join(', ')
    case 'unsupported':
      return value.display
  }
}

export function formatJiraEditFieldList(fields: JiraEditField[]): string {
  if (fields.length === 0) {
    return 'No edit fields. Jira lists only the fields this account can edit.'
  }
  return fields
    .map(
      (field) =>
        `${field.key}\t${field.name}\t${editFieldValueText(field.value)}${field.writable ? '' : '\t(read-only)'}`
    )
    .join('\n')
}

export function formatJiraCommentList(comments: JiraComment[]): string {
  if (comments.length === 0) {
    return 'No comments.'
  }
  return comments
    .map((comment) =>
      [`${comment.user?.displayName ?? 'unknown'} — ${comment.createdAt}`, comment.body].join('\n')
    )
    .join('\n\n')
}

export function formatJiraCreate(result: Extract<JiraCreateIssueResult, { ok: true }>): string {
  return [`Created ${result.key}`, `URL: ${result.url}`].join('\n')
}
