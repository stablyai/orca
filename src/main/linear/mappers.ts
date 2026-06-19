import type { Issue, IssueSearchResult } from '@linear/sdk'
import type { LinearIssue, LinearIssueChildSummary } from '../../shared/types'

type IssueWithChildren = Issue & {
  children: Issue['children']
}

type MapLinearIssueOptions = {
  includeChildren?: boolean
  includeProject?: boolean
}

async function optionalRelation<T>(value: Promise<T> | T): Promise<T | undefined> {
  try {
    return await value
  } catch {
    return undefined
  }
}

function mapLinearIssueChild(issue: Issue): LinearIssueChildSummary {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url
  }
}

// Why: the @linear/sdk uses lazy-loading for related entities — state, team,
// and assignee are fetched on property access and return promises. This mapper
// awaits them all so callers receive a plain serializable object safe for IPC
// transfer. Labels use the labels() method on Issue but IssueSearchResult only
// has labelIds (string UUIDs), so we conditionally resolve label names.
export async function mapLinearIssue(
  issue: Issue | IssueSearchResult,
  options: MapLinearIssueOptions = {}
): Promise<LinearIssue> {
  const [state, team, assignee, project] = await Promise.all([
    optionalRelation(issue.state),
    optionalRelation(issue.team),
    optionalRelation(issue.assignee),
    options.includeProject ? optionalRelation(issue.project) : Promise.resolve(undefined)
  ])

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

  let subIssues: LinearIssueChildSummary[] | undefined
  if (options.includeChildren && 'children' in issue && typeof issue.children === 'function') {
    try {
      const childrenConnection = await (issue as IssueWithChildren).children({ first: 25 })
      subIssues = childrenConnection.nodes.map(mapLinearIssueChild)
    } catch {
      // Swallow — child issues are secondary display data and creation still works without them.
    }
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
    project: project
      ? {
          id: project.id,
          name: project.name,
          url: project.url ?? undefined,
          color: project.color ?? undefined
        }
      : undefined,
    subIssues,
    labels: labelNames,
    labelIds,
    assignee: assignee
      ? {
          id: assignee.id,
          displayName: assignee.displayName,
          avatarUrl: assignee.avatarUrl ?? undefined
        }
      : undefined,
    estimate: issue.estimate ?? null,
    priority: issue.priority,
    dueDate: 'dueDate' in issue ? ((issue.dueDate as string | null | undefined) ?? null) : null,
    updatedAt: issue.updatedAt.toISOString()
  }
}
