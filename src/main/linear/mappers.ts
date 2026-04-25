import type { Issue, IssueSearchResult } from '@linear/sdk'
import type { LinearIssue } from '../../shared/types'

// Why: the @linear/sdk uses lazy-loading for related entities — state, team,
// and assignee are fetched on property access and return promises. This mapper
// awaits them all so callers receive a plain serializable object safe for IPC
// transfer. Labels use the labels() method on Issue but IssueSearchResult only
// has labelIds (string UUIDs), so we conditionally resolve label names.
export async function mapLinearIssue(issue: Issue | IssueSearchResult): Promise<LinearIssue> {
  const [state, team, assignee] = await Promise.all([issue.state, issue.team, issue.assignee])

  // Why: IssueSearchResult does not expose the labels() relation method — only
  // the raw labelIds array. For Issue instances we resolve actual label names;
  // for search results we fall back to empty (label names are a nice-to-have
  // in the UI, not critical for identification).
  let labelNames: string[] = []
  let labelIds: string[] = []
  if ('labels' in issue && typeof issue.labels === 'function') {
    try {
      const labelsConnection = await (issue as Issue).labels()
      labelNames = labelsConnection.nodes.map((l) => l.name)
      labelIds = labelsConnection.nodes.map((l) => l.id)
    } catch {
      // Swallow — labels are non-critical display data.
    }
  } else if ('labelIds' in issue && Array.isArray(issue.labelIds)) {
    labelIds = issue.labelIds as string[]
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    url: issue.url,
    state: {
      name: state?.name ?? '',
      type: state?.type ?? '',
      color: state?.color ?? ''
    },
    team: {
      id: team?.id ?? '',
      name: team?.name ?? '',
      key: team?.key ?? ''
    },
    labels: labelNames,
    labelIds,
    assignee: assignee
      ? {
          id: assignee.id,
          displayName: assignee.displayName,
          avatarUrl: assignee.avatarUrl ?? undefined
        }
      : undefined,
    priority: issue.priority,
    updatedAt: issue.updatedAt.toISOString()
  }
}
