import type { LinearIssue } from '../../shared/linear/issue-types'
import type { LinearWorkspaceSelection } from '../../shared/linear/workspace-types'
import { LINEAR_ISSUE_API_PAGE_SIZE_MAX } from '../../shared/linear/issue-read-limits'
import { buildLinearListIssueFilter } from './issue-list-filter'
import { mapLinearIssue } from './mappers'
import {
  ALL_ISSUES_QUERY,
  VIEWER_ASSIGNED_ISSUES_QUERY,
  VIEWER_CREATED_ISSUES_QUERY,
  type LinearIssueConnectionLoader,
  type LinearIssueConnectionResponse,
  type LinearIssueListOptions,
  type LinearIssueNode,
  type LinearRawVariables
} from './linear-issue-query-documents'
import type { LinearClientForWorkspace } from './client'
import type { LinearListFilter } from './linear-issue-listing'

export async function mapIssueForWorkspace(
  entry: LinearClientForWorkspace,
  issue: Parameters<typeof mapLinearIssue>[0],
  options?: Parameters<typeof mapLinearIssue>[1]
): Promise<LinearIssue> {
  const mapped = await mapLinearIssue(issue, options)
  return {
    ...mapped,
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.organizationName
  }
}

export function sortAndLimitIssues(issues: LinearIssue[], limit: number): LinearIssue[] {
  return issues
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
}

export function sortLimitAndDescribeIssues(
  issues: LinearIssue[],
  limit: number
): { items: LinearIssue[]; clipped: boolean } {
  const sorted = issues.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )
  return {
    items: sorted.slice(0, limit),
    clipped: sorted.length > limit
  }
}

export function mapRawIssueForWorkspace(
  entry: LinearClientForWorkspace,
  issue: LinearIssueNode
): LinearIssue {
  const labelNodes = issue.labels?.nodes ?? []
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    branchName: issue.branchName ?? undefined,
    description: issue.description ?? undefined,
    url: issue.url,
    state: {
      name: issue.state?.name ?? '',
      type: issue.state?.type ?? '',
      color: issue.state?.color ?? ''
    },
    team: {
      id: issue.team?.id ?? '',
      name: issue.team?.name ?? '',
      key: issue.team?.key ?? ''
    },
    labels: labelNodes.map((label) => label.name),
    // Why: labelIds drives full-replace updates. Keep Linear's complete id
    // list even when display label nodes are paginated.
    labelIds: issue.labelIds ?? labelNodes.map((label) => label.id),
    assignee: issue.assignee
      ? {
          id: issue.assignee.id,
          displayName: issue.assignee.displayName,
          avatarUrl: issue.assignee.avatarUrl ?? undefined
        }
      : undefined,
    estimate: issue.estimate ?? null,
    priority: issue.priority,
    dueDate: issue.dueDate ?? null,
    updatedAt: issue.updatedAt,
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.organizationName
  }
}

export async function readIssueConnectionPages(
  entry: LinearClientForWorkspace,
  limit: number,
  loadConnection: LinearIssueConnectionLoader
): Promise<{ items: LinearIssue[]; hasMore: boolean }> {
  const items: LinearIssue[] = []
  let after: string | undefined
  let hasMore = false

  while (items.length < limit) {
    // Why: Linear caps connection pages at 50, so larger Orca reads must walk
    // cursors instead of asking for the whole expanded limit in one request.
    const first = Math.min(LINEAR_ISSUE_API_PAGE_SIZE_MAX, limit - items.length)
    const connection = await loadConnection(after ? { first, after } : { first })
    const nodes = connection?.nodes ?? []
    items.push(...nodes.map((issue) => mapRawIssueForWorkspace(entry, issue)))
    hasMore = Boolean(connection?.pageInfo?.hasNextPage)

    const nextCursor = connection?.pageInfo?.endCursor ?? undefined
    if (!hasMore || !nextCursor || nextCursor === after || nodes.length === 0) {
      break
    }
    after = nextCursor
  }

  return { items, hasMore }
}

export function getOldestIssueTime(issues: LinearIssue[]): number {
  const oldestIssue = issues.at(-1)
  return oldestIssue ? new Date(oldestIssue.updatedAt).getTime() : Number.POSITIVE_INFINITY
}

export function getListIssueConnectionLoader(
  entry: LinearClientForWorkspace,
  filter: LinearListFilter,
  options?: LinearIssueListOptions
): LinearIssueConnectionLoader {
  const orderBy = 'updatedAt'
  const variables = { orderBy }
  // Why: apply attribute + team filters in GraphQL variables before the first-N
  // cursor walk so pagination hasMore matches the filtered set.
  const filterInput = buildLinearListIssueFilter({
    filter,
    teamId: options?.teamId,
    attributeFilter: options?.attributeFilter
  })

  if (filter === 'assigned') {
    return async (page) => {
      const result = await entry.client.client.rawRequest<
        LinearIssueConnectionResponse,
        LinearRawVariables
      >(VIEWER_ASSIGNED_ISSUES_QUERY, {
        ...variables,
        ...page,
        filter: filterInput
      })
      return result.data?.viewer?.assignedIssues
    }
  }

  if (filter === 'created') {
    return async (page) => {
      const result = await entry.client.client.rawRequest<
        LinearIssueConnectionResponse,
        LinearRawVariables
      >(VIEWER_CREATED_ISSUES_QUERY, {
        ...variables,
        ...page,
        filter: filterInput
      })
      return result.data?.viewer?.createdIssues
    }
  }

  if (filter === 'completed') {
    return async (page) => {
      const result = await entry.client.client.rawRequest<
        LinearIssueConnectionResponse,
        LinearRawVariables
      >(VIEWER_ASSIGNED_ISSUES_QUERY, {
        ...variables,
        ...page,
        filter: filterInput
      })
      return result.data?.viewer?.assignedIssues
    }
  }

  return async (page) => {
    const result = await entry.client.client.rawRequest<
      LinearIssueConnectionResponse,
      LinearRawVariables
    >(ALL_ISSUES_QUERY, { ...variables, ...page, filter: filterInput })
    return result.data?.issues
  }
}

export function shouldThrowAuthError(
  selection: LinearWorkspaceSelection | null | undefined
): boolean {
  return selection !== 'all'
}
