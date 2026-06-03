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
import {
  LINEAR_ISSUE_API_PAGE_SIZE_MAX,
  clampLinearIssueListLimit
} from '../../shared/linear-issue-read-limits'
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
    endCursor?: string | null
  }
}

type LinearRawVariables = Record<string, unknown>
type LinearIssuePageRequest = {
  first: number
  after?: string
}
type LinearIssueConnectionLoader = (
  page: LinearIssuePageRequest
) => Promise<LinearIssueConnection | null | undefined>

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
  query OrcaLinearIssues(
    $first: Int,
    $after: String,
    $filter: IssueFilter,
    $orderBy: PaginationOrderBy
  ) {
    issues(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
      nodes {
        ${LINEAR_ISSUE_NODE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

const VIEWER_ASSIGNED_ISSUES_QUERY = `
  query OrcaLinearViewerAssignedIssues(
    $first: Int,
    $after: String,
    $filter: IssueFilter,
    $orderBy: PaginationOrderBy
  ) {
    viewer {
      assignedIssues(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
        nodes {
          ${LINEAR_ISSUE_NODE_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`

const VIEWER_CREATED_ISSUES_QUERY = `
  query OrcaLinearViewerCreatedIssues(
    $first: Int,
    $after: String,
    $filter: IssueFilter,
    $orderBy: PaginationOrderBy
  ) {
    viewer {
      createdIssues(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
        nodes {
          ${LINEAR_ISSUE_NODE_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
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

async function readIssueConnectionPages(
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

function getOldestIssueTime(issues: LinearIssue[]): number {
  const oldestIssue = issues.at(-1)
  return oldestIssue ? new Date(oldestIssue.updatedAt).getTime() : Number.POSITIVE_INFINITY
}

function getListIssueConnectionLoader(
  entry: LinearClientForWorkspace,
  filter: LinearListFilter
): LinearIssueConnectionLoader {
  const orderBy = 'updatedAt'
  const variables = { orderBy }

  if (filter === 'assigned') {
    return async (page) => {
      const result = await entry.client.client.rawRequest<
        LinearIssueConnectionResponse,
        LinearRawVariables
      >(VIEWER_ASSIGNED_ISSUES_QUERY, {
        ...variables,
        ...page,
        filter: ACTIVE_STATE_FILTER
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
        filter: ACTIVE_STATE_FILTER
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
        filter: COMPLETED_STATE_FILTER
      })
      return result.data?.viewer?.assignedIssues
    }
  }

  return async (page) => {
    const result = await entry.client.client.rawRequest<
      LinearIssueConnectionResponse,
      LinearRawVariables
    >(ALL_ISSUES_QUERY, { ...variables, ...page, filter: ACTIVE_STATE_FILTER })
    return result.data?.issues
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

type LinearIssuePageResult = {
  items: LinearIssue[]
  hasMore: boolean
  endCursor?: string
}

type LinearIssueWorkspacePageState = {
  entry: LinearClientForWorkspace
  loadConnection: LinearIssueConnectionLoader
  items: LinearIssue[]
  hasMore: boolean
  canPage: boolean
  after?: string
}

async function readListIssuesForWorkspace(
  entry: LinearClientForWorkspace,
  filter: LinearListFilter,
  limit: number,
  workspaceId: LinearWorkspaceSelection | null | undefined
): Promise<{ items: LinearIssue[]; hasMore: boolean }> {
  await acquire()
  try {
    return readIssueConnectionPages(entry, limit, getListIssueConnectionLoader(entry, filter))
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
}

async function readIssueConnectionPage(
  entry: LinearClientForWorkspace,
  loadConnection: LinearIssueConnectionLoader,
  page: LinearIssuePageRequest
): Promise<LinearIssuePageResult> {
  const connection = await loadConnection(page)
  const nodes = connection?.nodes ?? []
  return {
    items: nodes.map((issue) => mapRawIssueForWorkspace(entry, issue)),
    hasMore: Boolean(connection?.pageInfo?.hasNextPage),
    endCursor: connection?.pageInfo?.endCursor ?? undefined
  }
}

async function readListIssuesPageForState(
  state: LinearIssueWorkspacePageState,
  first: number,
  workspaceId: LinearWorkspaceSelection | null | undefined
): Promise<void> {
  const previousCursor = state.after
  await acquire()
  try {
    const page = await readIssueConnectionPage(
      state.entry,
      state.loadConnection,
      previousCursor ? { first, after: previousCursor } : { first }
    )
    state.items.push(...page.items)
    state.hasMore = page.hasMore
    state.after = page.endCursor
    state.canPage = Boolean(
      page.hasMore && page.endCursor && page.endCursor !== previousCursor && page.items.length > 0
    )
  } catch (error) {
    state.items = []
    state.hasMore = false
    state.canPage = false
    if (isAuthError(error)) {
      clearToken(state.entry.workspace.id)
      if (shouldThrowAuthError(workspaceId)) {
        throw error
      }
    } else {
      console.warn('[linear] listIssues failed:', error)
    }
  } finally {
    release()
  }
}

function findWorkspaceToPageForLimit(
  states: LinearIssueWorkspacePageState[],
  limit: number
): LinearIssueWorkspacePageState | undefined {
  const merged = sortAndLimitIssues(
    states.flatMap((state) => state.items),
    limit
  )
  if (merged.length < limit) {
    return states
      .filter((state) => state.canPage)
      .sort((a, b) => getOldestIssueTime(b.items) - getOldestIssueTime(a.items))[0]
  }

  const cutoff = new Date(merged[limit - 1].updatedAt).getTime()
  return states
    .filter((state) => state.canPage && getOldestIssueTime(state.items) > cutoff)
    .sort((a, b) => getOldestIssueTime(b.items) - getOldestIssueTime(a.items))[0]
}

function countSelectedIssuesOlderThanWorkspaceBoundary(
  states: LinearIssueWorkspacePageState[],
  stateToPage: LinearIssueWorkspacePageState,
  limit: number
): number {
  const boundary = getOldestIssueTime(stateToPage.items)
  return sortAndLimitIssues(
    states.flatMap((state) => state.items),
    limit
  ).filter((issue) => new Date(issue.updatedAt).getTime() < boundary).length
}

async function readListIssuesAcrossWorkspaces(
  entries: LinearClientForWorkspace[],
  filter: LinearListFilter,
  limit: number,
  workspaceId: LinearWorkspaceSelection | null | undefined
): Promise<LinearCollectionResult<LinearIssue>> {
  const states: LinearIssueWorkspacePageState[] = entries.map((entry) => ({
    entry,
    loadConnection: getListIssueConnectionLoader(entry, filter),
    items: [],
    hasMore: false,
    canPage: false
  }))
  const first = Math.min(LINEAR_ISSUE_API_PAGE_SIZE_MAX, limit)

  // Why: "all workspaces" is a global sorted list. Pull one bounded page per
  // workspace first, then spend additional API calls only where unseen issues
  // can still change the global updatedAt cutoff.
  await Promise.all(states.map((state) => readListIssuesPageForState(state, first, workspaceId)))

  for (;;) {
    const nextState = findWorkspaceToPageForLimit(states, limit)
    if (!nextState) {
      break
    }
    const itemCount = states.reduce((count, state) => count + state.items.length, 0)
    const pageSize =
      itemCount < limit
        ? Math.min(LINEAR_ISSUE_API_PAGE_SIZE_MAX, limit - itemCount)
        : Math.min(
            LINEAR_ISSUE_API_PAGE_SIZE_MAX,
            Math.max(1, countSelectedIssuesOlderThanWorkspaceBoundary(states, nextState, limit))
          )
    await readListIssuesPageForState(nextState, pageSize, workspaceId)
  }

  const limited = sortLimitAndDescribeIssues(
    states.flatMap((state) => state.items),
    limit
  )
  return {
    items: limited.items,
    hasMore: states.some((state) => state.hasMore) || limited.clipped
  }
}

export async function listIssues(
  filter: LinearListFilter = 'assigned',
  limit = 20,
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearCollectionResult<LinearIssue>> {
  const effectiveLimit = clampLinearIssueListLimit(limit)
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return { items: [] }
  }

  if (entries.length === 1) {
    return readListIssuesForWorkspace(entries[0], filter, effectiveLimit, workspaceId)
  }

  return readListIssuesAcrossWorkspaces(entries, filter, effectiveLimit, workspaceId)
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
