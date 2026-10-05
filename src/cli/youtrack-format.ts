import type { YouTrackComment, YouTrackIssue } from '../shared/youtrack-types'

function issueHeadline(issue: YouTrackIssue): string {
  return `${issue.idReadable}  ${issue.summary}`
}

function issueFacts(issue: YouTrackIssue): string {
  const facts = [
    issue.state ? `State: ${issue.state.name}` : null,
    issue.priority ? `Priority: ${issue.priority}` : null,
    issue.type ? `Type: ${issue.type}` : null,
    `Assignee: ${issue.assignee?.fullName ?? 'Unassigned'}`,
    issue.unresolvedBlockerCount > 0
      ? `Blocked by ${issue.unresolvedBlockerCount} open issue(s)`
      : null
  ]
  return facts.filter(Boolean).join(' · ')
}

export function formatYouTrackIssue(result: {
  issue: YouTrackIssue
  comments?: YouTrackComment[]
}): string {
  const { issue, comments } = result
  const lines = [issueHeadline(issue), issueFacts(issue), issue.url]
  const extraFields = issue.fields.filter(
    (field) =>
      field.value !== null &&
      field.name !== issue.stateFieldName &&
      !/^(assignee|priority|type)$/i.test(field.name)
  )
  if (extraFields.length > 0) {
    lines.push('', 'Fields:', ...extraFields.map((field) => `  ${field.name}: ${field.value}`))
  }
  if (issue.tags.length > 0) {
    lines.push(`Tags: ${issue.tags.map((tag) => tag.name).join(', ')}`)
  }
  for (const group of issue.links) {
    lines.push('', `${group.label}:`)
    for (const linked of group.issues) {
      const status = linked.resolved ? 'resolved' : (linked.state ?? 'open')
      lines.push(`  ${linked.idReadable} [${status}] ${linked.summary}`)
    }
  }
  lines.push('', issue.description?.trim() || '(no description)')
  if (comments) {
    lines.push('', `Comments (${comments.length}):`)
    for (const comment of comments) {
      lines.push(
        '',
        `— ${comment.author?.fullName ?? 'Unknown'}, ${comment.createdAt}`,
        comment.text
      )
    }
  }
  return lines.join('\n')
}

export function formatYouTrackIssueList(result: { issues: YouTrackIssue[] }): string {
  if (result.issues.length === 0) {
    return 'No YouTrack issues found.'
  }
  return result.issues
    .map((issue) => {
      const state = issue.state?.name ?? '—'
      const blocked = issue.unresolvedBlockerCount > 0 ? ' [blocked]' : ''
      return `${issue.idReadable.padEnd(10)} ${state.padEnd(14)} ${issue.summary}${blocked}`
    })
    .join('\n')
}

export function formatYouTrackComment(result: {
  idReadable: string
  comment: YouTrackComment
}): string {
  return `Commented on ${result.idReadable} (comment ${result.comment.id}).`
}

export function formatYouTrackIssueSaved(result: { issue: YouTrackIssue }): string {
  return [issueHeadline(result.issue), issueFacts(result.issue), result.issue.url].join('\n')
}
