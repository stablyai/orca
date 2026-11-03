import type {
  LinearAttachResult,
  LinearCommentAddResult,
  LinearCommentDeleteResult,
  LinearCommentEditResult,
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
} from '../shared/linear/agent-access'
import { appendLinearListTruncation } from '../shared/linear/list-truncation-format'
import { linearPriorityLabel } from '../shared/linear/priority-label'
import {
  formatLinearProjectListRows,
  linearProjectListWarningLines
} from '../shared/linear/project-list-format'
import { terminalSafeLine as safe } from '../shared/terminal-safe-text'

export function formatLinearIssue(result: LinearIssueContextResult): string {
  const issue = result.issue
  const lines = [
    `${safe(issue.identifier)} ${safe(issue.title)}`,
    `URL: ${safe(issue.url)}`,
    `State: ${safe(issue.state?.name ?? 'unknown')}`,
    `Assignee: ${safe(issue.assignee?.displayName ?? 'unassigned')}`,
    `Project: ${safe(issue.project?.name ?? 'none')}`
  ]
  lines.push(`Priority: ${formatPriority(issue.priority)}`)
  lines.push(`Estimate: ${issue.estimate ?? 'none'}`)
  if (issue.labels.length > 0) {
    lines.push(
      `Labels: ${issue.labels
        .map((label) => safe(label.name ?? ''))
        .filter(Boolean)
        .join(', ')}`
    )
  }
  if (issue.dueDate) {
    lines.push(`Due: ${safe(issue.dueDate)}`)
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
  return appendLinearListTruncation(
    result.issues.map(formatSearchRow).join('\n'),
    result.issues.length,
    result.truncated ?? result.meta.limitReached
  )
}

export function formatLinearTeamList(result: LinearTeamListResult): string {
  if (result.teams.length === 0) {
    return 'No Linear teams found.'
  }
  return result.teams
    .map((team) => {
      const workspace = team.workspace ? ` ${safe(team.workspace.name)}` : ''
      return `${safe(team.key).padEnd(10)} ${safe(team.name)}${workspace}`
    })
    .join('\n')
}

export function formatLinearTeamMembers(result: LinearTeamMembersResult): string {
  if (result.members.length === 0) {
    return `No Linear members found for ${safe(result.team.key)}.`
  }
  return result.members
    .map((member) => `${safe(member.displayName ?? 'unknown').padEnd(24)} ${safe(member.id ?? '')}`)
    .join('\n')
}

export function formatLinearTeamStates(result: LinearTeamStatesResult): string {
  if (result.states.length === 0) {
    return `No Linear workflow states found for ${safe(result.team.key)}.`
  }
  return result.states
    .map(
      (state) =>
        `${safe(state.name).padEnd(24)} ${safe(state.type ?? '').padEnd(12)} ${safe(state.id)}`
    )
    .join('\n')
}

export function formatLinearTeamLabels(result: LinearTeamLabelsResult): string {
  if (result.labels.length === 0) {
    return `No Linear labels found for ${safe(result.team.key)}.`
  }
  return result.labels.map((label) => `${safe(label.name).padEnd(24)} ${safe(label.id)}`).join('\n')
}

export function formatLinearIssueList(result: LinearIssueListResult): string {
  if (result.issues.length === 0) {
    return 'No Linear issues found.'
  }
  return appendLinearListTruncation(
    result.issues.map(formatSearchRow).join('\n'),
    result.issues.length,
    result.truncated ?? result.meta.hasMore
  )
}

export function formatLinearMcpIssueList(result: LinearMcpIssueListResult): string {
  if (result.issues.length === 0) {
    return 'No Linear issues found.'
  }
  return appendLinearListTruncation(
    result.issues.map(formatSearchRow).join('\n'),
    result.issues.length,
    result.truncated ?? result.meta.hasMore
  )
}

export function printLinearMcpIssueListWarnings(result: LinearMcpIssueListResult): void {
  if (result.meta.hasMore) {
    const workspaceHint =
      result.meta.nextCursor && result.meta.workspaceId !== 'all' && result.meta.workspaceId
        ? `; continue with --workspace ${safe(result.meta.workspaceId)}`
        : ''
    console.error(
      `warning: more results available; next cursor: ${safe(result.meta.nextCursor ?? 'n/a')}${workspaceHint}`
    )
  }
  for (const error of result.meta.workspaceErrors) {
    console.error(
      `warning: ${safe(error.workspace.name)} unavailable for Linear: ${safe(error.message)}`
    )
  }
}

export function formatLinearProjectList(result: LinearProjectListResult): string {
  return formatLinearProjectListRows(result)
}

export function formatLinearStatusSet(result: LinearStatusSetResult): string {
  const suffix = result.meta.alreadyInState ? ' (already set)' : ''
  return `Set ${safe(result.issue.identifier)} to ${safe(result.state.name)}${suffix}.`
}

export function formatLinearCommentAdd(result: LinearCommentAddResult): string {
  const suffix = result.meta.deduplicated ? ' (already posted)' : ''
  return `Added comment ${safe(result.comment.id)} to ${safe(result.issue.identifier)}${suffix}.`
}

export function formatLinearCommentEdit(result: LinearCommentEditResult): string {
  return `Edited comment ${safe(result.comment.id)} on ${safe(result.issue.identifier)}.`
}

export function formatLinearCommentDelete(result: LinearCommentDeleteResult): string {
  return `Deleted comment ${safe(result.comment.id)} from ${safe(result.issue.identifier)}.`
}

export function formatLinearAttach(result: LinearAttachResult): string {
  const suffix = result.meta.deduplicated ? ' (already attached)' : ''
  return `Attached ${safe(result.attachment.title)} to ${safe(result.issue.identifier)}${suffix}.`
}

export function formatLinearCreate(result: LinearCreateResult | LinearSaveIssueResult): string {
  const parent = result.issue.parent ? ` under ${safe(result.issue.parent.identifier)}` : ''
  const project = result.issue.project?.name ? ` in ${safe(result.issue.project.name)}` : ''
  const suffix = result.meta.deduplicated ? ' (already created)' : ''
  return `Created ${safe(result.issue.identifier)}${parent}${project}: ${safe(result.issue.title)}${suffix}.`
}

export function formatLinearSaveIssue(result: LinearSaveIssueResult): string {
  if (result.meta.created) {
    return formatLinearCreate(result)
  }
  return `Saved ${safe(result.issue.identifier)}: ${safe(result.issue.title)}.`
}

export function formatLinearTaskUpdate(result: LinearIssueTaskUpdateResult): string {
  const suffix = result.meta.alreadySet ? ' (already set)' : ''
  return `Updated ${safe(result.issue.identifier)} ${taskOperationLabel(result.operation)}${suffix}.`
}

export function formatLinearRelationWrite(result: LinearIssueRelationWriteResult): string {
  const verb = result.operation === 'add' ? 'Added' : 'Removed'
  const suffix = result.meta.alreadySet
    ? result.operation === 'add'
      ? ' (already present)'
      : ' (already absent)'
    : ''
  return `${verb} ${safe(result.issue.identifier)} ${result.relation.relationship} ${safe(result.relatedIssue.identifier)}${suffix}.`
}

export function printLinearIssueWarnings(result: LinearIssueContextResult): void {
  for (const error of result.meta.includeErrors) {
    console.error(`warning: ${error.include} unavailable: ${safe(error.message)}`)
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
      `warning: ${safe(error.workspace.name)} unavailable for Linear search: ${safe(error.message)}`
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
    console.error(
      `warning: ${safe(error.workspace.name)} unavailable for Linear: ${safe(error.message)}`
    )
  }
}

export function printLinearProjectListWarnings(result: LinearProjectListResult): void {
  for (const warning of linearProjectListWarningLines(result)) {
    console.error(warning)
  }
}

function formatSearchRow(issue: LinearSearchIssueSummary): string {
  const state = safe(issue.state?.name ?? 'unknown')
  const assignee = safe(issue.assignee?.displayName ?? 'unassigned')
  return `${safe(issue.identifier).padEnd(10)} ${state.padEnd(14)} ${assignee.padEnd(18)} ${safe(issue.title)}`
}

function formatPriority(priority: number | null | undefined): string {
  return linearPriorityLabel(priority)
}

function taskOperationLabel(operation: LinearIssueTaskUpdateResult['operation']): string {
  if (operation === 'dueDate') {
    return 'due date'
  }
  return operation
}
