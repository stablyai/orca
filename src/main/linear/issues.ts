/* eslint-disable max-lines -- Why: Linear issue reads and mutations share the
   same workspace fan-out/error handling, so keeping them together avoids
   drifting auth-clearing behavior between operations. */
import type {
  LinearIssue,
  LinearIssueUpdate,
  LinearComment,
  LinearCollectionResult,
  LinearWorkspaceError,
  LinearWorkspaceSelection
} from '../../shared/types'
import { LinearClient } from '@linear/sdk'
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
  dueDate?: string | null
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

export type LinearWriteFailureKind = 'duplicate_id' | 'failed' | 'network' | 'unconfirmed'

export class LinearWriteFailure extends Error {
  readonly kind: LinearWriteFailureKind
  readonly cause: unknown

  constructor(kind: LinearWriteFailureKind, message: string, cause?: unknown) {
    super(message)
    this.name = 'LinearWriteFailure'
    this.kind = kind
    this.cause = cause
  }
}

export type LinearIssueWriteRecord = {
  id: string
  identifier: string
  title: string
  description?: string | null
  url: string
  team: { id: string; key: string; name: string }
  state: { id: string; name: string } | null
  parent: { id: string; identifier: string } | null
  project?: { id: string; name: string } | null
  assignee?: { id: string; displayName: string } | null
  priority?: number | null
  estimate?: number | null
  dueDate?: string | null
  labelIds?: string[] | null
  labels?: { id: string; name: string }[]
}

export type LinearCommentWriteRecord = {
  id: string
  url: string | null
  body: string
  issue: { id: string; identifier: string; url: string }
  parentId: string | null
  threadRootId: string | null
}

export type LinearAttachmentWriteRecord = {
  id: string
  title: string
  url: string
  issue: { id: string; identifier: string; url: string }
}

const LINEAR_ISSUE_NODE_FIELDS = `
  id
  identifier
  title
  description
  url
  dueDate
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

const AGENT_ISSUE_WRITE_FIELDS = `
  id
  identifier
  title
  description
  url
  team { id key name }
  state { id name }
  parent { id identifier }
  project { id name }
  assignee { id displayName }
  priority
  estimate
  dueDate
  labelIds
  labels(first: 50) { nodes { id name } }
`

const ISSUE_BY_UUID_QUERY = `
  query OrcaLinearIssueByUuid($id: String!) {
    issue(id: $id) {
      ${AGENT_ISSUE_WRITE_FIELDS}
    }
  }
`

const COMMENT_BY_UUID_QUERY = `
  query OrcaLinearCommentByUuid($id: String!) {
    comment(id: $id) {
      id
      url
      body
      parent { id }
      issue { id identifier url }
    }
  }
`

const ATTACHMENT_BY_UUID_QUERY = `
  query OrcaLinearAttachmentByUuid($id: String!) {
    attachment(id: $id) {
      id
      title
      url
      issue { id identifier url }
    }
  }
`

// Why: fetch comments with their author in a single request. Accessing
// `.user` on the SDK's Comment model lazily issues one user(id) query per
// comment, so the previous loop was an N+1 (issue + comments + N user
// fetches, all sequential while holding a shared Linear concurrency slot).
// first: 50 matches the SDK default page size the previous code relied on.
const ISSUE_COMMENTS_QUERY = `
  query OrcaLinearIssueComments($id: String!) {
    issue(id: $id) {
      comments(first: 50) {
        nodes {
          id
          body
          createdAt
          user {
            displayName
            avatarUrl
          }
        }
      }
    }
  }
`

type LinearIssueByUuidResponse = {
  issue?:
    | (Omit<LinearIssueWriteRecord, 'labels'> & {
        labels?: { nodes?: { id: string; name: string }[] } | null
      })
    | null
}

type LinearCommentByUuidResponse = {
  comment?: {
    id: string
    url?: string | null
    body?: string | null
    parent?: { id?: string | null } | null
    issue?: { id?: string | null; identifier?: string | null; url?: string | null } | null
  } | null
}

type LinearAttachmentByUuidResponse = {
  attachment?: {
    id: string
    title?: string | null
    url?: string | null
    issue?: { id?: string | null; identifier?: string | null; url?: string | null } | null
  } | null
}

type LinearIssueCommentsResponse = {
  issue?: {
    comments?: {
      nodes?:
        | {
            id: string
            body?: string | null
            createdAt?: string | null
            user?: { displayName?: string | null; avatarUrl?: string | null } | null
          }[]
        | null
    } | null
  } | null
}

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
    dueDate: issue.dueDate ?? null,
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
  filter: LinearListFilter,
  teamId?: string
): LinearIssueConnectionLoader {
  const orderBy = 'updatedAt'
  const variables = { orderBy }
  const filterInput = listIssueFilter(filter, teamId)

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

function shouldThrowAuthError(selection: LinearWorkspaceSelection | null | undefined): boolean {
  return selection !== 'all'
}

function linearWriteMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isDuplicateIdError(error: unknown): boolean {
  const message = linearWriteMessage(error).toLowerCase()
  return (
    message.includes('duplicate') ||
    message.includes('already exists') ||
    message.includes('already in use') ||
    message.includes('id has already')
  )
}

function errorCauseCode(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return ''
  }
  const cause = (error as { cause?: unknown }).cause
  if (!cause || typeof cause !== 'object') {
    return ''
  }
  const code = (cause as { code?: unknown }).code
  return typeof code === 'string' ? code.toLowerCase() : ''
}

function classifyWriteFailure(error: unknown): LinearWriteFailure {
  if (error instanceof LinearWriteFailure) {
    return error
  }
  if (isDuplicateIdError(error)) {
    return new LinearWriteFailure('duplicate_id', linearWriteMessage(error), error)
  }
  const message = linearWriteMessage(error)
  const lower = message.toLowerCase()
  const code = errorCauseCode(error)
  if (
    lower.includes('enotfound') ||
    lower.includes('econnrefused') ||
    code === 'enotfound' ||
    code === 'econnrefused'
  ) {
    return new LinearWriteFailure('network', message, error)
  }
  if (
    lower.includes('abort') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('network') ||
    lower.includes('econnreset') ||
    lower.includes('fetch failed') ||
    lower.includes('socket')
  ) {
    return new LinearWriteFailure('unconfirmed', message, error)
  }
  return new LinearWriteFailure('failed', message, error)
}

async function runLinearWrite<T>(
  entry: LinearClientForWorkspace,
  signal: AbortSignal | undefined,
  write: (client: LinearClient) => Promise<T>
): Promise<T> {
  await acquire()
  try {
    const client = signal ? new LinearClient({ apiKey: entry.apiKey, signal }) : entry.client
    return await write(client)
  } catch (error) {
    if (error instanceof LinearWriteFailure) {
      throw error
    }
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    throw classifyWriteFailure(error)
  } finally {
    release()
  }
}

async function runLinearLookup<T>(
  entry: LinearClientForWorkspace,
  lookup: () => Promise<T>
): Promise<T | null> {
  await acquire()
  try {
    return await lookup()
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    if (isLinearLookupMiss(error)) {
      return null
    }
    throw error
  } finally {
    release()
  }
}

function isLinearLookupMiss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  // Why: Linear throws for direct entity lookups that miss; write-id probes
  // need the same null shape as GraphQL nullable data, not a failed write.
  return message.includes('Entity not found:') && message.includes('Could not find referenced')
}

async function confirmLinearWrite<T>(message: string, readback: () => Promise<T>): Promise<T> {
  try {
    return await readback()
  } catch (error) {
    throw new LinearWriteFailure('unconfirmed', message, error)
  }
}

function mapRawCommentWriteRecord(
  comment: NonNullable<LinearCommentByUuidResponse['comment']>
): LinearCommentWriteRecord | null {
  const issue = comment.issue
  if (!issue?.id || !issue.identifier || !issue.url) {
    return null
  }
  const parentId = comment.parent?.id ?? null
  return {
    id: comment.id,
    url: comment.url ?? null,
    body: comment.body ?? '',
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url
    },
    parentId,
    threadRootId: parentId ?? comment.id
  }
}

function mapRawAttachmentWriteRecord(
  attachment: NonNullable<LinearAttachmentByUuidResponse['attachment']>
): LinearAttachmentWriteRecord | null {
  const issue = attachment.issue
  if (!issue?.id || !issue.identifier || !issue.url || !attachment.url) {
    return null
  }
  return {
    id: attachment.id,
    title: attachment.title ?? attachment.url,
    url: attachment.url,
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url
    }
  }
}

function mapRawIssueWriteRecord(
  issue: NonNullable<LinearIssueByUuidResponse['issue']>
): LinearIssueWriteRecord {
  return {
    ...issue,
    labels: issue.labels?.nodes ?? []
  }
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

export async function getIssueByUuidForAgent(
  id: string,
  workspaceId?: string | null
): Promise<LinearIssueWriteRecord | null> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return null
  }

  return runLinearLookup(entry, async () => {
    const result = await entry.client.client.rawRequest<
      LinearIssueByUuidResponse,
      LinearRawVariables
    >(ISSUE_BY_UUID_QUERY, { id })
    const issue = result.data?.issue ?? null
    return issue ? mapRawIssueWriteRecord(issue) : null
  })
}

export async function getCommentByUuidForAgent(
  id: string,
  workspaceId?: string | null
): Promise<LinearCommentWriteRecord | null> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return null
  }

  return runLinearLookup(entry, async () => {
    const result = await entry.client.client.rawRequest<
      LinearCommentByUuidResponse,
      LinearRawVariables
    >(COMMENT_BY_UUID_QUERY, { id })
    const comment = result.data?.comment
    return comment ? mapRawCommentWriteRecord(comment) : null
  })
}

export async function getAttachmentByUuidForAgent(
  id: string,
  workspaceId?: string | null
): Promise<LinearAttachmentWriteRecord | null> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return null
  }

  return runLinearLookup(entry, async () => {
    const result = await entry.client.client.rawRequest<
      LinearAttachmentByUuidResponse,
      LinearRawVariables
    >(ATTACHMENT_BY_UUID_QUERY, { id })
    const attachment = result.data?.attachment
    return attachment ? mapRawAttachmentWriteRecord(attachment) : null
  })
}

export async function getIssueCommentThreadRoot(
  issueId: string,
  commentId: string,
  workspaceId?: string | null
): Promise<{ id: string; parentId: string | null } | null> {
  const comment = await getCommentByUuidForAgent(commentId, workspaceId)
  if (!comment || comment.issue.id !== issueId) {
    return null
  }
  return { id: comment.threadRootId ?? comment.id, parentId: comment.parentId }
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

export type LinearListFilter = 'assigned' | 'created' | 'all' | 'completed' | 'open'

const ACTIVE_STATE_FILTER = { state: { type: { nin: ['completed', 'canceled'] } } }
const COMPLETED_STATE_FILTER = { state: { type: { in: ['completed', 'canceled'] } } }

function listFilterForState(filter: LinearListFilter): Record<string, unknown> | undefined {
  if (filter === 'assigned' || filter === 'created' || filter === 'open') {
    return ACTIVE_STATE_FILTER
  }
  if (filter === 'completed') {
    return COMPLETED_STATE_FILTER
  }
  return undefined
}

function listIssueFilter(
  filter: LinearListFilter,
  teamId?: string
): Record<string, unknown> | undefined {
  const stateFilter = listFilterForState(filter)
  const teamFilter = teamId ? { team: { id: { eq: teamId } } } : undefined
  if (stateFilter && teamFilter) {
    return { ...stateFilter, ...teamFilter }
  }
  return stateFilter ?? teamFilter
}

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
  error?: LinearWorkspaceError
  after?: string
}

function linearWorkspaceError(
  entry: LinearClientForWorkspace,
  error: unknown
): LinearWorkspaceError {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLocaleLowerCase()
  const type: LinearWorkspaceError['type'] = isAuthError(error)
    ? 'auth'
    : lower.includes('rate limit') || lower.includes('429')
      ? 'rate_limited'
      : lower.includes('network') ||
          lower.includes('timeout') ||
          lower.includes('fetch failed') ||
          lower.includes('econnreset') ||
          lower.includes('enotfound')
        ? 'network'
        : 'unknown'
  return {
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.organizationName,
    type,
    message
  }
}

async function readListIssuesForWorkspace(
  entry: LinearClientForWorkspace,
  filter: LinearListFilter,
  limit: number,
  workspaceId: LinearWorkspaceSelection | null | undefined,
  teamId?: string
): Promise<LinearCollectionResult<LinearIssue>> {
  await acquire()
  try {
    return await readIssueConnectionPages(
      entry,
      limit,
      getListIssueConnectionLoader(entry, filter, teamId)
    )
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      if (shouldThrowAuthError(workspaceId)) {
        throw error
      }
    } else {
      console.warn('[linear] listIssues failed:', error)
    }
    return { items: [], hasMore: false, errors: [linearWorkspaceError(entry, error)] }
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
    state.error = linearWorkspaceError(state.entry, error)
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
  workspaceId: LinearWorkspaceSelection | null | undefined,
  teamId?: string
): Promise<LinearCollectionResult<LinearIssue>> {
  const states: LinearIssueWorkspacePageState[] = entries.map((entry) => ({
    entry,
    loadConnection: getListIssueConnectionLoader(entry, filter, teamId),
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
    hasMore: states.some((state) => state.hasMore) || limited.clipped,
    errors: states.flatMap((state) => (state.error ? [state.error] : []))
  }
}

export async function listIssues(
  filter: LinearListFilter = 'assigned',
  limit = 20,
  workspaceId?: LinearWorkspaceSelection | null,
  teamId?: string
): Promise<LinearCollectionResult<LinearIssue>> {
  const effectiveLimit = clampLinearIssueListLimit(limit)
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return { items: [] }
  }

  if (entries.length === 1) {
    return readListIssuesForWorkspace(entries[0], filter, effectiveLimit, workspaceId, teamId)
  }

  return readListIssuesAcrossWorkspaces(entries, filter, effectiveLimit, workspaceId, teamId)
}

export async function createIssue(
  teamId: string,
  title: string,
  description?: string,
  workspaceId?: string | null,
  options?: {
    id?: string
    parentId?: string
    projectId?: string | null
    stateId?: string
    priority?: number
    estimate?: number | null
    dueDate?: string | null
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
      ...(options?.id ? { id: options.id } : {}),
      teamId,
      title,
      ...(description ? { description } : {}),
      ...(options?.parentId ? { parentId: options.parentId } : {}),
      ...(options?.projectId ? { projectId: options.projectId } : {}),
      ...(options?.stateId ? { stateId: options.stateId } : {}),
      ...(options?.priority !== undefined ? { priority: options.priority } : {}),
      ...(options?.estimate !== undefined ? { estimate: options.estimate } : {}),
      ...(options?.dueDate !== undefined ? { dueDate: options.dueDate } : {}),
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

export async function createIssueForAgent(
  teamId: string,
  title: string,
  description: string | undefined,
  workspaceId: string,
  options: {
    id: string
    parentId?: string | null
    projectId?: string | null
    stateId?: string
    assigneeId?: string | null
    priority?: number
    estimate?: number | null
    dueDate?: string | null
    labelIds?: string[]
    signal?: AbortSignal
  }
): Promise<LinearIssueWriteRecord> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new LinearWriteFailure('failed', 'Not connected to Linear')
  }

  return runLinearWrite(entry, options.signal, async (client) => {
    const result = await client.createIssue({
      id: options.id,
      teamId,
      title,
      ...(description ? { description } : {}),
      ...(options.parentId ? { parentId: options.parentId } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.stateId ? { stateId: options.stateId } : {}),
      ...(options.assigneeId !== undefined ? { assigneeId: options.assigneeId } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.estimate !== undefined ? { estimate: options.estimate } : {}),
      ...(options.dueDate !== undefined ? { dueDate: options.dueDate } : {}),
      ...(options.labelIds !== undefined ? { labelIds: options.labelIds } : {})
    })
    if (!result.success) {
      throw new LinearWriteFailure('failed', 'Linear create failed')
    }
    const issue = await confirmLinearWrite(
      'Issue was created but could not be retrieved',
      async () => result.issue
    )
    if (!issue?.id) {
      throw new LinearWriteFailure('unconfirmed', 'Issue was created but could not be retrieved')
    }
    return confirmLinearWrite('Issue was created but could not be retrieved', () =>
      getCreatedIssueRecord(issue.id, client)
    )
  })
}

async function getCreatedIssueRecord(
  issueId: string,
  client: LinearClient
): Promise<LinearIssueWriteRecord> {
  const result = await client.client.rawRequest<LinearIssueByUuidResponse, LinearRawVariables>(
    ISSUE_BY_UUID_QUERY,
    { id: issueId }
  )
  const record = result.data?.issue ?? null
  if (!record) {
    throw new LinearWriteFailure('unconfirmed', 'Issue was created but could not be retrieved')
  }
  return mapRawIssueWriteRecord(record)
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
    if (updates.dueDate !== undefined) {
      payload.dueDate = updates.dueDate
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

export async function updateIssueForAgent(
  id: string,
  updates: Pick<
    LinearIssueUpdate,
    'stateId' | 'assigneeId' | 'priority' | 'estimate' | 'dueDate' | 'labelIds'
  >,
  workspaceId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LinearIssueWriteRecord> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new LinearWriteFailure('failed', 'Not connected to Linear')
  }

  return runLinearWrite(entry, options.signal, async (client) => {
    const payload: Record<string, unknown> = {}
    if (updates.stateId !== undefined) {
      payload.stateId = updates.stateId
    }
    if (updates.assigneeId !== undefined) {
      payload.assigneeId = updates.assigneeId
    }
    if (updates.priority !== undefined) {
      payload.priority = updates.priority
    }
    if (updates.estimate !== undefined) {
      payload.estimate = updates.estimate
    }
    if (updates.dueDate !== undefined) {
      payload.dueDate = updates.dueDate
    }
    if (updates.labelIds !== undefined) {
      payload.labelIds = updates.labelIds
    }
    const result = await client.updateIssue(id, payload)
    if (!result.success) {
      throw new LinearWriteFailure('failed', 'Linear update failed')
    }
    return confirmLinearWrite('Issue was updated but could not be retrieved', () =>
      getCreatedIssueRecord(id, client)
    )
  })
}

export async function addIssueComment(
  issueId: string,
  body: string,
  workspaceId?: string | null,
  options?: { id?: string; parentId?: string | null }
): Promise<
  | { ok: true; id: string; url?: string | null; parentId?: string | null }
  | { ok: false; error: string }
> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Linear' }
  }

  await acquire()
  try {
    const result = await entry.client.createComment({
      ...(options?.id ? { id: options.id } : {}),
      issueId,
      body,
      ...(options?.parentId ? { parentId: options.parentId } : {})
    })
    if (!result.success) {
      return { ok: false, error: 'Failed to create comment' }
    }
    const comment = await result.comment
    return {
      ok: true,
      id: comment?.id ?? '',
      url: comment?.url ?? null,
      parentId: options?.parentId ?? null
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

export async function addIssueCommentForAgent(
  issueId: string,
  body: string,
  workspaceId: string,
  options: { id: string; parentId?: string | null; signal?: AbortSignal }
): Promise<LinearCommentWriteRecord> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new LinearWriteFailure('failed', 'Not connected to Linear')
  }

  return runLinearWrite(entry, options.signal, async (client) => {
    const result = await client.createComment({
      id: options.id,
      issueId,
      body,
      ...(options.parentId ? { parentId: options.parentId } : {})
    })
    if (!result.success) {
      throw new LinearWriteFailure('failed', 'Failed to create comment')
    }
    const comment = await confirmLinearWrite(
      'Comment was created but could not be retrieved',
      async () => result.comment
    )
    if (!comment?.id) {
      throw new LinearWriteFailure('unconfirmed', 'Comment was created but could not be retrieved')
    }
    const record = await confirmLinearWrite('Comment was created but could not be retrieved', () =>
      readCommentWriteRecord(client, comment.id)
    )
    if (!record) {
      throw new LinearWriteFailure('unconfirmed', 'Comment was created but could not be retrieved')
    }
    return record
  })
}

export async function createIssueAttachment(
  issueId: string,
  input: { id: string; title: string; url: string },
  workspaceId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LinearAttachmentWriteRecord> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new LinearWriteFailure('failed', 'Not connected to Linear')
  }

  return runLinearWrite(entry, options.signal, async (client) => {
    const result = await client.createAttachment({
      id: input.id,
      issueId,
      title: input.title,
      url: input.url
    })
    if (!result.success) {
      throw new LinearWriteFailure('failed', 'Failed to create attachment')
    }
    const attachment = await confirmLinearWrite(
      'Attachment was created but could not be retrieved',
      async () => result.attachment
    )
    if (!attachment?.id) {
      throw new LinearWriteFailure(
        'unconfirmed',
        'Attachment was created but could not be retrieved'
      )
    }
    const record = await confirmLinearWrite(
      'Attachment was created but could not be retrieved',
      () => readAttachmentWriteRecord(client, attachment.id)
    )
    if (!record) {
      throw new LinearWriteFailure(
        'unconfirmed',
        'Attachment was created but could not be retrieved'
      )
    }
    return record
  })
}

async function readCommentWriteRecord(
  client: LinearClient,
  id: string
): Promise<LinearCommentWriteRecord | null> {
  const result = await client.client.rawRequest<LinearCommentByUuidResponse, LinearRawVariables>(
    COMMENT_BY_UUID_QUERY,
    { id }
  )
  const comment = result.data?.comment
  return comment ? mapRawCommentWriteRecord(comment) : null
}

async function readAttachmentWriteRecord(
  client: LinearClient,
  id: string
): Promise<LinearAttachmentWriteRecord | null> {
  const result = await client.client.rawRequest<LinearAttachmentByUuidResponse, LinearRawVariables>(
    ATTACHMENT_BY_UUID_QUERY,
    { id }
  )
  const attachment = result.data?.attachment
  return attachment ? mapRawAttachmentWriteRecord(attachment) : null
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
    const result = await entry.client.client.rawRequest<
      LinearIssueCommentsResponse,
      LinearRawVariables
    >(ISSUE_COMMENTS_QUERY, { id: issueId })
    const nodes = result.data?.issue?.comments?.nodes ?? []
    return nodes.map((node) => ({
      id: node.id,
      body: node.body ?? '',
      // Why: rawRequest returns createdAt as an ISO string already; do not
      // re-serialize (the SDK model path used .toISOString() on a parsed Date).
      createdAt: node.createdAt ?? '',
      user: node.user
        ? {
            displayName: node.user.displayName ?? '',
            avatarUrl: node.user.avatarUrl ?? undefined
          }
        : undefined
    }))
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
