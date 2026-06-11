import type {
  LinearIssueContextResult,
  LinearSearchIssueSummary,
  LinearSearchResult
} from '../shared/linear-agent-access'

export function formatLinearIssue(result: LinearIssueContextResult): string {
  const issue = result.issue
  const lines = [
    `${issue.identifier} ${issue.title}`,
    `URL: ${issue.url}`,
    `State: ${issue.state?.name ?? 'unknown'}`,
    `Assignee: ${issue.assignee?.displayName ?? 'unassigned'}`,
    `Project: ${issue.project?.name ?? 'none'}`
  ]
  if (issue.labels.length > 0) {
    lines.push(
      `Labels: ${issue.labels
        .map((label) => label.name)
        .filter(Boolean)
        .join(', ')}`
    )
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
  return lines.join('\n')
}

export function formatLinearSearch(result: LinearSearchResult): string {
  if (result.issues.length === 0) {
    return 'No Linear issues found.'
  }
  return result.issues.map(formatSearchRow).join('\n')
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

function formatSearchRow(issue: LinearSearchIssueSummary): string {
  const state = issue.state?.name ?? 'unknown'
  const assignee = issue.assignee?.displayName ?? 'unassigned'
  return `${issue.identifier.padEnd(10)} ${state.padEnd(14)} ${assignee.padEnd(18)} ${issue.title}`
}
