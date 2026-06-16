import type {
  LinearIssueContextResult,
  LinearIssueListResult,
  LinearIssueTaskUpdateResult,
  LinearSearchIssueSummary,
  LinearSearchResult,
  LinearTeamListResult,
  LinearTeamLabelsResult,
  LinearTeamMembersResult,
  LinearTeamStatesResult,
  LinearStatusSetResult,
  LinearCommentAddResult,
  LinearAttachResult,
  LinearCreateResult
} from '../../shared/linear-agent-access'
import {
  isLinearAttachResult,
  isLinearCommentAddResult,
  isLinearCreateResult,
  isLinearIssueContextResult,
  isLinearIssueListResult,
  isLinearSearchResult,
  isLinearStatusSetResult,
  isLinearTaskUpdateResult,
  isLinearTeamLabelsResult,
  isLinearTeamListResult,
  isLinearTeamMembersResult,
  isLinearTeamStatesResult
} from './ssh-remote-linear-result-guards'

export function formatRemoteLinearCli(result: unknown): { stdout: string; stderr: string } | null {
  if (isLinearIssueContextResult(result)) {
    return { stdout: `${formatLinearIssue(result)}\n`, stderr: linearIssueWarnings(result) }
  }
  if (isLinearSearchResult(result)) {
    return {
      stdout: `${formatLinearIssueRows(result.issues)}\n`,
      stderr: linearListWarnings(result, 'Linear search')
    }
  }
  if (isLinearIssueListResult(result)) {
    return {
      stdout: `${formatLinearIssueRows(result.issues)}\n`,
      stderr: linearListWarnings(result)
    }
  }
  if (isLinearTeamListResult(result)) {
    return { stdout: `${formatLinearTeamList(result)}\n`, stderr: linearListWarnings(result) }
  }
  if (isLinearTeamMembersResult(result)) {
    return { stdout: `${formatLinearTeamMembers(result)}\n`, stderr: '' }
  }
  if (isLinearTeamStatesResult(result)) {
    return { stdout: `${formatLinearTeamStates(result)}\n`, stderr: '' }
  }
  if (isLinearTeamLabelsResult(result)) {
    return { stdout: `${formatLinearTeamLabels(result)}\n`, stderr: '' }
  }
  if (isLinearStatusSetResult(result)) {
    return { stdout: `${formatLinearStatusSet(result)}\n`, stderr: '' }
  }
  if (isLinearTaskUpdateResult(result)) {
    return { stdout: `${formatLinearTaskUpdate(result)}\n`, stderr: '' }
  }
  if (isLinearCommentAddResult(result)) {
    return { stdout: `${formatLinearCommentAdd(result)}\n`, stderr: '' }
  }
  if (isLinearAttachResult(result)) {
    return { stdout: `${formatLinearAttach(result)}\n`, stderr: '' }
  }
  if (isLinearCreateResult(result)) {
    return { stdout: `${formatLinearCreate(result)}\n`, stderr: '' }
  }
  return null
}

function formatLinearIssue(result: LinearIssueContextResult): string {
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
  for (const section of ['comments', 'children', 'attachments', 'relations'] as const) {
    const meta = result.meta.sections[section]
    if (meta) {
      lines.push(`${section[0].toUpperCase()}${section.slice(1)}: ${meta.returned}`)
    }
  }
  return lines.join('\n')
}

function formatLinearIssueRows(issues: LinearSearchIssueSummary[]): string {
  if (issues.length === 0) {
    return 'No Linear issues found.'
  }
  return issues.map(formatLinearIssueRow).join('\n')
}

function formatLinearIssueRow(issue: LinearSearchIssueSummary): string {
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

function formatLinearTeamList(result: LinearTeamListResult): string {
  if (result.teams.length === 0) {
    return 'No Linear teams found.'
  }
  return result.teams
    .map(
      (team) =>
        `${team.key.padEnd(10)} ${team.name}${team.workspace ? ` ${team.workspace.name}` : ''}`
    )
    .join('\n')
}

function formatLinearTeamMembers(result: LinearTeamMembersResult): string {
  if (result.members.length === 0) {
    return `No Linear members found for ${result.team.key}.`
  }
  return result.members
    .map((member) => `${(member.displayName ?? 'unknown').padEnd(24)} ${member.id ?? ''}`)
    .join('\n')
}

function formatLinearTeamStates(result: LinearTeamStatesResult): string {
  if (result.states.length === 0) {
    return `No Linear workflow states found for ${result.team.key}.`
  }
  return result.states
    .map((state) => `${state.name.padEnd(24)} ${(state.type ?? '').padEnd(12)} ${state.id}`)
    .join('\n')
}

function formatLinearTeamLabels(result: LinearTeamLabelsResult): string {
  if (result.labels.length === 0) {
    return `No Linear labels found for ${result.team.key}.`
  }
  return result.labels.map((label) => `${label.name.padEnd(24)} ${label.id}`).join('\n')
}

function formatLinearStatusSet(result: LinearStatusSetResult): string {
  const suffix = result.meta.alreadyInState ? ' (already set)' : ''
  return `Set ${result.issue.identifier} to ${result.state.name}${suffix}.`
}

function formatLinearTaskUpdate(result: LinearIssueTaskUpdateResult): string {
  const suffix = result.meta.alreadySet ? ' (already set)' : ''
  return `Updated ${result.issue.identifier} ${taskOperationLabel(result.operation)}${suffix}.`
}

function formatLinearCommentAdd(result: LinearCommentAddResult): string {
  const suffix = result.meta.deduplicated ? ' (already posted)' : ''
  return `Added comment ${result.comment.id} to ${result.issue.identifier}${suffix}.`
}

function formatLinearAttach(result: LinearAttachResult): string {
  const suffix = result.meta.deduplicated ? ' (already attached)' : ''
  return `Attached ${result.attachment.title} to ${result.issue.identifier}${suffix}.`
}

function formatLinearCreate(result: LinearCreateResult): string {
  const parent = result.issue.parent ? ` under ${result.issue.parent.identifier}` : ''
  const suffix = result.meta.deduplicated ? ' (already created)' : ''
  return `Created ${result.issue.identifier}${parent}: ${result.issue.title}${suffix}.`
}

function taskOperationLabel(operation: LinearIssueTaskUpdateResult['operation']): string {
  return operation === 'dueDate' ? 'due date' : operation
}

function linearIssueWarnings(result: LinearIssueContextResult): string {
  const warnings = result.meta.includeErrors.map(
    (error) => `warning: ${error.include} unavailable: ${error.message}`
  )
  for (const [name, meta] of Object.entries(result.meta.sections)) {
    if (meta?.capReached) {
      warnings.push(`warning: ${name} capped at ${meta.returned}/${meta.cap}`)
    }
  }
  return warnings.length > 0 ? `${warnings.join('\n')}\n` : ''
}

function linearListWarnings(
  result: LinearSearchResult | LinearIssueListResult | LinearTeamListResult,
  label = 'Linear'
): string {
  const warnings: string[] = []
  const meta = result.meta
  if ('hasMore' in meta && meta.hasMore) {
    warnings.push(`warning: showing first ${meta.returned} Linear issues`)
  }
  if ('limitReached' in meta && meta.limitReached) {
    warnings.push(`warning: showing first ${meta.returned} Linear issues`)
  }
  for (const error of meta.workspaceErrors ?? []) {
    warnings.push(`warning: ${error.workspace.name} unavailable for ${label}: ${error.message}`)
  }
  return warnings.length > 0 ? `${warnings.join('\n')}\n` : ''
}
