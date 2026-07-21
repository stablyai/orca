import type {
  LinearAttachResult,
  LinearCommentAddResult,
  LinearCreateResult,
  LinearIssueListResult,
  LinearMcpIssueListResult,
  LinearIssueContextResult,
  LinearIssueTaskUpdateResult,
  LinearIssueRelationWriteResult,
  LinearSaveIssueResult,
  LinearProjectListResult,
  LinearSearchIssueSummary,
  LinearSearchResult,
  LinearTeamLabelsResult,
  LinearTeamListResult,
  LinearTeamMembersResult,
  LinearTeamStatesResult,
  LinearStatusSetResult
} from '../shared/linear-agent-access'
import {
  formatLinearProjectListRows,
  linearProjectListWarningLines
} from '../shared/linear-project-list-format'

export function formatLinearIssue(result: LinearIssueContextResult): string {
  const issue = result.issue
  const lines = [
    `${issue.identifier} ${issue.title}`,
    `URL: ${issue.url}`,
    `State: ${issue.state?.name ?? 'unknown'}`,
    `Assignee: ${issue.assignee?.displayName ?? 'unassigned'}`,
    `Project: ${issue.project?.name ?? 'none'}`
  ]
  lines.push(`Priority: ${formatPriority(issue.priority)}`)
  lines.push(`Estimate: ${issue.estimate ?? 'none'}`)
  if (issue.labels.length > 0) {
    lines.push(
      `Labels: ${issue.labels
        .map((label) => label.name)
        .filter(Boolean)
        .join(', ')}`
    )
  }
  if (issue.dueDate) {
    lines.push(`Due: ${issue.dueDate}`)
  }
  const sections = result.meta.sections
  if (sections.comments) {
    lines.push(`Comments: ${sections.comments.returned}`)
  }
  if (sections.children) {
    lines.push(`Children: ${sections.children.returned}`)
  }
  if (sections.attachments) {
    lines.push(`Attachments: ${sections.attachments.returned}`)
  }
  if (sections.relations) {
    lines.push(`Relations: ${sections.relations.returned}`)
  }
  if (sections.activity) {
    lines.push(`Activity: ${sections.activity.returned}`)
  }
  if (result.inlineMedia?.length) {
    lines.push(`Inline media: ${result.inlineMedia.length} (use --json for URLs)`)
  }
  return lines.join('\n')
}

export function formatLinearSearch(result: LinearSearchResult): string {
  if (result.issues.length === 0) {
    return 'No Linear issues found.'
  }
  return result.issues.map(formatSearchRow).join('\n')
}

export function formatLinearTeamList(result: LinearTeamListResult): string {
  if (result.teams.length === 0) {
    return 'No Linear teams found.'
  }
  return result.teams
    .map((team) => {
      const workspace = team.workspace ? ` ${team.workspace.name}` : ''
      return `${team.key.padEnd(10)} ${team.name}${workspace}`
    })
    .join('\n')
}

export function formatLinearTeamMembers(result: LinearTeamMembersResult): string {
  if (result.members.length === 0) {
    return `No Linear members found for ${result.team.key}.`
  }
  return result.members
    .map((member) => `${(member.displayName ?? 'unknown').padEnd(24)} ${member.id ?? ''}`)
    .join('\n')
}

export function formatLinearTeamStates(result: LinearTeamStatesResult): string {
  if (result.states.length === 0) {
    return `No Linear workflow states found for ${result.team.key}.`
  }
  return result.states
    .map((state) => `${state.name.padEnd(24)} ${(state.type ?? '').padEnd(12)} ${state.id}`)
    .join('\n')
}

export function formatLinearTeamLabels(result: LinearTeamLabelsResult): string {
  if (result.labels.length === 0) {
    return `No Linear labels found for ${result.team.key}.`
  }
  return result.labels.map((label) => `${label.name.padEnd(24)} ${label.id}`).join('\n')
}

export function formatLinearIssueList(result: LinearIssueListResult): string {
  if (result.issues.length === 0) {
    return 'No Linear issues found.'
  }
  return result.issues.map(formatSearchRow).join('\n')
}

export function formatLinearMcpIssueList(result: LinearMcpIssueListResult): string {
  if (result.issues.length === 0) {
    return 'No Linear issues found.'
  }
  return result.issues.map(formatSearchRow).join('\n')
}

export function printLinearMcpIssueListWarnings(result: LinearMcpIssueListResult): void {
  if (result.meta.hasMore) {
    const workspaceHint =
      result.meta.nextCursor && result.meta.workspaceId !== 'all' && result.meta.workspaceId
        ? `; continue with --workspace ${result.meta.workspaceId}`
        : ''
    console.error(
      `warning: more results available; next cursor: ${result.meta.nextCursor ?? 'n/a'}${workspaceHint}`
    )
  }
  for (const error of result.meta.workspaceErrors) {
    console.error(`warning: ${error.workspace.name} unavailable for Linear: ${error.message}`)
  }
}

export function formatLinearProjectList(result: LinearProjectListResult): string {
  return formatLinearProjectListRows(result)
}

export function formatLinearStatusSet(result: LinearStatusSetResult): string {
  const suffix = result.meta.alreadyInState ? ' (already set)' : ''
  return `Set ${result.issue.identifier} to ${result.state.name}${suffix}.`
}

export function formatLinearCommentAdd(result: LinearCommentAddResult): string {
  const suffix = result.meta.deduplicated ? ' (already posted)' : ''
  return `Added comment ${result.comment.id} to ${result.issue.identifier}${suffix}.`
}

export function formatLinearAttach(result: LinearAttachResult): string {
  const suffix = result.meta.deduplicated ? ' (already attached)' : ''
  return `Attached ${result.attachment.title} to ${result.issue.identifier}${suffix}.`
}

export function formatLinearCreate(result: LinearCreateResult | LinearSaveIssueResult): string {
  const parent = result.issue.parent ? ` under ${result.issue.parent.identifier}` : ''
  const project = result.issue.project?.name ? ` in ${result.issue.project.name}` : ''
  const suffix = result.meta.deduplicated ? ' (already created)' : ''
  return `Created ${result.issue.identifier}${parent}${project}: ${result.issue.title}${suffix}.`
}

export function formatLinearSaveIssue(result: LinearSaveIssueResult): string {
  if (result.meta.created) {
    return formatLinearCreate(result)
  }
  return `Saved ${result.issue.identifier}: ${result.issue.title}.`
}

export function formatLinearTaskUpdate(result: LinearIssueTaskUpdateResult): string {
  const suffix = result.meta.alreadySet ? ' (already set)' : ''
  return `Updated ${result.issue.identifier} ${taskOperationLabel(result.operation)}${suffix}.`
}

export function formatLinearRelationWrite(result: LinearIssueRelationWriteResult): string {
  const verb = result.operation === 'add' ? 'Added' : 'Removed'
  const suffix = result.meta.alreadySet
    ? result.operation === 'add'
      ? ' (already present)'
      : ' (already absent)'
    : ''
  return `${verb} ${result.issue.identifier} ${result.relation.relationship} ${result.relatedIssue.identifier}${suffix}.`
}

export function printLinearIssueWarnings(result: LinearIssueContextResult): void {
  for (const error of result.meta.includeErrors) {
    console.error(`warning: ${error.include} unavailable: ${error.message}`)
  }
  for (const [name, meta] of Object.entries(result.meta.sections)) {
    if (meta?.capReached) {
      console.error(`warning: ${name} capped at ${meta.returned}/${meta.cap}`)
    }
  }
}

export function printLinearSearchWarnings(result: LinearSearchResult): void {
  if (result.meta.limitReached) {
    console.error(`warning: showing first ${result.meta.returned} Linear issues`)
  }
  for (const error of result.meta.workspaceErrors ?? []) {
    console.error(
      `warning: ${error.workspace.name} unavailable for Linear search: ${error.message}`
    )
  }
}

export function printLinearListWarnings(
  result: LinearSearchResult | LinearIssueListResult | LinearTeamListResult
): void {
  const meta = result.meta
  if ('hasMore' in meta && meta.hasMore) {
    console.error(`warning: showing first ${meta.returned} Linear issues`)
  }
  if ('limitReached' in meta && meta.limitReached) {
    console.error(`warning: showing first ${meta.returned} Linear issues`)
  }
  for (const error of meta.workspaceErrors ?? []) {
    console.error(`warning: ${error.workspace.name} unavailable for Linear: ${error.message}`)
  }
}

export function printLinearProjectListWarnings(result: LinearProjectListResult): void {
  for (const warning of linearProjectListWarningLines(result)) {
    console.error(warning)
  }
}

function formatSearchRow(issue: LinearSearchIssueSummary): string {
  const state = issue.state?.name ?? 'unknown'
  const assignee = issue.assignee?.displayName ?? 'unassigned'
  return `${issue.identifier.padEnd(10)} ${state.padEnd(14)} ${assignee.padEnd(18)} ${issue.title}`
}

function formatPriority(priority: number | null | undefined): string {
  if (priority == null || priority === 0) {
    return 'none'
  }
  switch (priority) {
    case 1:
      return 'urgent'
    case 2:
      return 'high'
    case 3:
      return 'medium'
    case 4:
      return 'low'
    default:
      return 'none'
  }
}

function taskOperationLabel(operation: LinearIssueTaskUpdateResult['operation']): string {
  if (operation === 'dueDate') {
    return 'due date'
  }
  return operation
}
