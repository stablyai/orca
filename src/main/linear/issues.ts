/* eslint-disable max-lines -- Why: Linear issue reads and mutations share the
   same workspace fan-out/error handling, so keeping them together avoids
   drifting auth-clearing behavior between operations. */
import type {
  LinearIssue,
  LinearIssueUpdate,
  LinearComment,
  LinearCollectionResult,
  LinearWorkspaceSelection
} from '../../shared/types'
import { clampLinearPlainIssueListLimit } from '../../shared/linear-issue-list-limits'
import {
  acquire,
  release,
  getClients,
  isAuthError,
  clearToken,
  type LinearClientForWorkspace
} from './client'
import { mapLinearIssue } from './mappers'

type LinearIssueNode = {
  id: string
  identifier: string
  title: string
  description?: string | null
  url: string
  estimate?: number | null
  priority: number
  updatedAt: string
  labelIds?: string[] | null
  state?: {
    name?: string | null
    type?: string | null
    color?: string | null
  } | null
  team?: {
    id?: string | null
    name?: string | null
    key?: string | null
  } | null
  assignee?: {
    id: string
    displayName: string
    avatarUrl?: string | null
  } | null
  labels?: {
    nodes?: { id: string; name: string }[]
  } | null
}

type LinearIssueConnectionResponse = {
  searchIssues?: { nodes?: LinearIssueNode[] }
  issues?: LinearIssueConnection
  viewer?: {
    assignedIssues?: LinearIssueConnection
    createdIssues?: LinearIssueConnection
  }
}

type LinearIssueConnection = {
  nodes?: LinearIssueNode[]
  pageInfo?: {
    hasNextPage?: boolean
  }
}

type LinearRawVariables = Record<string, unknown>

const LINEAR_ISSUE_NODE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  estimate
  updatedAt
  labelIds
  state {
    name
    type
    color
  }
  team {
    id
    name
    key
  }
  assignee {
    id
    displayName
    avatarUrl
  }
  labels(first: 50) {
    nodes {
      id
      name
    }
  }
`

const SEARCH_ISSUES_QUERY = `
  query OrcaLinearIssueSearch($term: String!, $first: Int) {
    searchIssues(term: $term, first: $first) {
      nodes {
        ${LINEAR_ISSUE_NODE_FIELDS}
      }
    }
  }
`

const ALL_ISSUES_QUERY = `
  query OrcaLinearIssues($first: Int, $filter: IssueFilter, $orderBy: PaginationOrderBy) {
    issues(first: $first, filter: $filter, orderBy: $orderBy) {
      nodes {
        ${LINEAR_ISSUE_NODE_FIELDS}
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`

const VIEWER_ASSIGNED_ISSUES_QUERY = `
  query OrcaLinearViewerAssignedIssues(
    $first: Int,
    $filter: IssueFilter,
    $orderBy: PaginationOrderBy
  ) {
    viewer {
      assignedIssues(first: $first, filter: $filter, orderBy: $orderBy) {
        nodes {
          ${LINEAR_ISSUE_NODE_FIELDS}
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`

const VIEWER_CREATED_ISSUES_QUERY = `
  query OrcaLinearViewerCreatedIssues(
    $first: Int,
    $filter: IssueFilter,
    $orderBy: PaginationOrderBy
  ) {
    viewer {
      createdIssues(first: $first, filter: $filter, orderBy: $orderBy) {
        nodes {
          ${LINEAR_ISSUE_NODE_FIELDS}
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`

async function mapIssueForWorkspace(
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

function sortAndLimitIssues(issues: LinearIssue[], limit: number): LinearIssue[] {
  return issues
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
}

function sortLimitAndDescribeIssues(
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

function mapRawIssueForWorkspace(
  entry: LinearClientForWorkspace,
  issue: LinearIssueNode
): LinearIssue {
  const labelNodes = issue.labels?.nodes ?? []
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
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
    updatedAt: issue.updatedAt,
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.organizationName
  }
}

function shouldThrowAuthError(selection: LinearWorkspaceSelection | null | undefined): boolean {
  return selection !== 'all'
}

export async function getIssue(
  id: string,
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearIssue | null> {
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return null
  }

  for (const entry of entries) {
    await acquire()
    try {
      const issue = await entry.client.issue(id)
      return await mapIssueForWorkspace(entry, issue, {
        includeChildren: true,
        includeProject: true
      })
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(entry.workspace.id)
        if (shouldThrowAuthError(workspaceId)) {
          throw error
        }
      } else {
        console.warn('[linear] getIssue failed:', error)
      }
    } finally {
      release()
    }
  }
  return null
}

export async function searchIssues(
  query: string,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearIssue[]> {
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return []
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        const result = await entry.client.client.rawRequest<
          LinearIssueConnectionResponse,
          LinearRawVariables
        >(SEARCH_ISSUES_QUERY, { term: query, first: limit })
        const nodes = result.data?.searchIssues?.nodes ?? []
        return nodes.map((issue) => mapRawIssueForWorkspace(entry, issue))
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
          if (shouldThrowAuthError(workspaceId)) {
            throw error
          }
        } else {
          console.warn('[linear] searchIssues failed:', error)
        }
        return []
      } finally {
        release()
      }
    })
  )
  // Why: searchIssues returns Linear's relevance ranking. Re-sorting by
  // updatedAt would discard relevance order for single-workspace results,
  // diverging from Linear's web UI and pre-PR behavior.
  if (entries.length === 1) {
    return results.flat().slice(0, limit)
  }
  return sortAndLimitIssues(results.flat(), limit)
}

export type LinearListFilter = 'assigned' | 'created' | 'all' | 'completed'

const ACTIVE_STATE_FILTER = { state: { type: { nin: ['completed', 'canceled'] } } }
const COMPLETED_STATE_FILTER = { state: { type: { in: ['completed', 'canceled'] } } }

export async function listIssues(
  filter: LinearListFilter = 'assigned',
  limit = 20,
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearCollectionResult<LinearIssue>> {
  const effectiveLimit = clampLinearPlainIssueListLimit(limit)
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return { items: [] }
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        const orderBy = 'updatedAt'
        const variables = { first: effectiveLimit, orderBy }

        if (filter === 'assigned') {
          const result = await entry.client.client.rawRequest<
            LinearIssueConnectionResponse,
            LinearRawVariables
          >(VIEWER_ASSIGNED_ISSUES_QUERY, { ...variables, filter: ACTIVE_STATE_FILTER })
          const connection = result.data?.viewer?.assignedIssues
          return {
            items: (connection?.nodes ?? []).map((issue) => mapRawIssueForWorkspace(entry, issue)),
            hasMore: Boolean(connection?.pageInfo?.hasNextPage)
          }
        }

        if (filter === 'created') {
          const result = await entry.client.client.rawRequest<
            LinearIssueConnectionResponse,
            LinearRawVariables
          >(VIEWER_CREATED_ISSUES_QUERY, { ...variables, filter: ACTIVE_STATE_FILTER })
          const connection = result.data?.viewer?.createdIssues
          return {
            items: (connection?.nodes ?? []).map((issue) => mapRawIssueForWorkspace(entry, issue)),
            hasMore: Boolean(connection?.pageInfo?.hasNextPage)
          }
        }

        if (filter === 'completed') {
          const result = await entry.client.client.rawRequest<
            LinearIssueConnectionResponse,
            LinearRawVariables
          >(VIEWER_ASSIGNED_ISSUES_QUERY, { ...variables, filter: COMPLETED_STATE_FILTER })
          const connection = result.data?.viewer?.assignedIssues
          return {
            items: (connection?.nodes ?? []).map((issue) => mapRawIssueForWorkspace(entry, issue)),
            hasMore: Boolean(connection?.pageInfo?.hasNextPage)
          }
        }

        // 'all' — all active issues across the workspace
        const result = await entry.client.client.rawRequest<
          LinearIssueConnectionResponse,
          LinearRawVariables
        >(ALL_ISSUES_QUERY, { ...variables, filter: ACTIVE_STATE_FILTER })
        const connection = result.data?.issues
        return {
          items: (connection?.nodes ?? []).map((issue) => mapRawIssueForWorkspace(entry, issue)),
          hasMore: Boolean(connection?.pageInfo?.hasNextPage)
        }
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
          if (shouldThrowAuthError(workspaceId)) {
            throw error
          }
        } else {
          console.warn('[linear] listIssues failed:', error)
        }
        return { items: [], hasMore: false }
      } finally {
        release()
      }
    })
  )
  const merged = results.flatMap((result) => result.items)
  const limited = sortLimitAndDescribeIssues(merged, effectiveLimit)
  return {
    items: limited.items,
    hasMore: results.some((result) => result.hasMore) || limited.clipped
  }
}

export async function createIssue(
  teamId: string,
  title: string,
  description?: string,
  workspaceId?: string | null,
  options?: {
    parentId?: string
    projectId?: string | null
    stateId?: string
    priority?: number
    assigneeId?: string | null
    labelIds?: string[]
  }
): Promise<
  | { ok: true; id: string; identifier: string; title: string; url: string }
  | { ok: false; error: string }
> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Linear' }
  }

  await acquire()
  try {
    const result = await entry.client.createIssue({
      teamId,
      title,
      ...(description ? { description } : {}),
      ...(options?.parentId ? { parentId: options.parentId } : {}),
      ...(options?.projectId ? { projectId: options.projectId } : {}),
      ...(options?.stateId ? { stateId: options.stateId } : {}),
      ...(options?.priority !== undefined ? { priority: options.priority } : {}),
      ...(options?.assigneeId ? { assigneeId: options.assigneeId } : {}),
      ...(options?.labelIds ? { labelIds: options.labelIds } : {})
    })
    if (!result.success) {
      return { ok: false, error: 'Linear create failed' }
    }
    const issue = await result.issue
    if (!issue) {
      return { ok: false, error: 'Issue was created but could not be retrieved' }
    }
    return {
      ok: true,
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url
    }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function updateIssue(
  id: string,
  updates: LinearIssueUpdate,
  workspaceId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Linear' }
  }

  await acquire()
  try {
    // Why: labelIds is a full-replace field — a TOCTOU race exists if another
    // user changes labels between fetch and write. The caller passes the
    // complete set built from recently-fetched data. Acceptable for v1;
    // a future version could re-fetch right before writing or use webhooks.
    const resolvedLabelIds = updates.labelIds

    const payload: Record<string, unknown> = {}
    if (updates.stateId !== undefined) {
      payload.stateId = updates.stateId
    }
    if (updates.title !== undefined) {
      payload.title = updates.title
    }
    if (updates.description !== undefined) {
      payload.description = updates.description
    }
    if (updates.assigneeId !== undefined) {
      payload.assigneeId = updates.assigneeId
    }
    if (updates.estimate !== undefined) {
      payload.estimate = updates.estimate
    }
    if (updates.priority !== undefined) {
      payload.priority = updates.priority
    }
    if (resolvedLabelIds !== undefined) {
      payload.labelIds = resolvedLabelIds
    }
    if (updates.projectId !== undefined) {
      payload.projectId = updates.projectId
    }

    const result = await entry.client.updateIssue(id, payload)
    if (!result.success) {
      return { ok: false, error: 'Linear update failed' }
    }
    return { ok: true }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function addIssueComment(
  issueId: string,
  body: string,
  workspaceId?: string | null
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Linear' }
  }

  await acquire()
  try {
    const result = await entry.client.createComment({ issueId, body })
    if (!result.success) {
      return { ok: false, error: 'Failed to create comment' }
    }
    const comment = await result.comment
    return { ok: true, id: comment?.id ?? '' }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function getIssueComments(
  issueId: string,
  workspaceId?: string | null
): Promise<LinearComment[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }

  await acquire()
  try {
    const issue = await entry.client.issue(issueId)
    const comments = await issue.comments()
    const results: LinearComment[] = []
    for (const c of comments.nodes) {
      const user = await c.user
      results.push({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        user: user
          ? { displayName: user.displayName, avatarUrl: user.avatarUrl ?? undefined }
          : undefined
      })
    }
    return results
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[linear] getIssueComments failed:', error)
    return []
  } finally {
    release()
  }
}
