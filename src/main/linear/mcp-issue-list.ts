import type {
  LinearMcpIssueListRequest,
  LinearMcpIssueListResult
} from '../../shared/linear-agent-access'
import { getClients, getStatus, type LinearClientForWorkspace } from './client'
import { withLinearRead } from './issue-context-client'
import { linearError } from './issue-context-errors'
import {
  getFanoutClientEntries,
  workspaceFailure,
  type WorkspaceReadFailure
} from './issue-context-fanout'
import { ISSUE_FIELDS, mapIssue, type RawIssue } from './issue-context-raw'
import { resolveWorkspaceSelector } from './issue-context-workspaces'

const LIST_ISSUES_DEFAULT_LIMIT = 50
const LIST_ISSUES_MAX_LIMIT = 250

type RawListIssuesResponse = {
  issues?: {
    nodes?: RawIssue[]
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
  } | null
}

type WorkspaceIssuePage = {
  issues: LinearMcpIssueListResult['issues']
  hasMore: boolean
  nextCursor?: string
}

const LIST_ISSUES_QUERY = `
  query OrcaLinearListIssues(
    $first: Int!
    $after: String
    $filter: IssueFilter
    $orderBy: PaginationOrderBy
    $includeArchived: Boolean
  ) {
    issues(
      first: $first
      after: $after
      filter: $filter
      orderBy: $orderBy
      includeArchived: $includeArchived
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`

export async function listMcpIssues(
  request: LinearMcpIssueListRequest
): Promise<LinearMcpIssueListResult> {
  if (request.cursor && (!request.workspaceId || request.workspaceId === 'all')) {
    throw linearError(
      'linear_invalid_workspace',
      'Cursor pagination requires a concrete Linear workspace.'
    )
  }
  const limit = clampLimit(request.limit)
  const orderBy = request.orderBy ?? 'updatedAt'
  const { entries, failures: entryFailures } = getIssueListEntries(request.workspaceId)
  if (entries.length === 0) {
    if (entryFailures[0]) {
      throw entryFailures[0].error
    }
    throw linearError('linear_not_connected', 'Linear is not connected.', {
      nextSteps: ['Connect Linear from Orca settings, then retry the issue list.']
    })
  }
  const { pages, failures } = await readIssueListWorkspaces(
    entries,
    request,
    limit,
    orderBy,
    entryFailures
  )
  const issues = pages.flatMap((page) => page.issues)
  let hasMore = pages.some((page) => page.hasMore)

  issues.sort((left, right) => compareIssues(left, right, orderBy))
  if (issues.length > limit) {
    hasMore = true
    issues.length = limit
  }
  return {
    issues,
    meta: {
      limit,
      returned: issues.length,
      hasMore,
      ...(hasMore && request.workspaceId !== 'all' && pages.length === 1 && pages[0].nextCursor
        ? { nextCursor: pages[0].nextCursor }
        : {}),
      orderBy,
      workspaceId: request.workspaceId === 'all' ? 'all' : entries[0].workspace.id,
      partial: failures.length > 0,
      workspaceErrors: failures.map(({ workspace, code, message }) => ({
        workspace,
        code,
        message
      }))
    }
  }
}

function getIssueListEntries(workspaceId?: string | 'all'): {
  entries: LinearClientForWorkspace[]
  failures: WorkspaceReadFailure[]
} {
  if (workspaceId === 'all') {
    return getFanoutClientEntries()
  }
  if (workspaceId) {
    resolveWorkspaceSelector({ workspaceId }, getStatus().workspaces ?? [])
  }
  return { entries: getClients(workspaceId), failures: [] }
}

async function readIssueListWorkspaces(
  entries: LinearClientForWorkspace[],
  request: LinearMcpIssueListRequest,
  limit: number,
  orderBy: 'createdAt' | 'updatedAt',
  initialFailures: WorkspaceReadFailure[]
): Promise<{ pages: WorkspaceIssuePage[]; failures: WorkspaceReadFailure[] }> {
  if (request.workspaceId !== 'all') {
    return {
      pages: [await readIssueListWorkspace(entries[0], request, limit, orderBy)],
      failures: []
    }
  }

  const settled = await Promise.allSettled(
    entries.map((entry) => readIssueListWorkspace(entry, request, limit, orderBy))
  )
  const pages: WorkspaceIssuePage[] = []
  const failures = [...initialFailures]
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index]
    if (result.status === 'fulfilled') {
      pages.push(result.value)
      continue
    }
    failures.push(workspaceFailure(entries[index].workspace, result.reason))
  }
  if (pages.length === 0 && failures.length === entries.length + initialFailures.length) {
    throw failures[0].error
  }
  return { pages, failures }
}

async function readIssueListWorkspace(
  entry: LinearClientForWorkspace,
  request: LinearMcpIssueListRequest,
  limit: number,
  orderBy: 'createdAt' | 'updatedAt'
): Promise<WorkspaceIssuePage> {
  return await withLinearRead(entry, async () => {
    const raw = await entry.client.client.rawRequest<
      RawListIssuesResponse,
      Record<string, unknown>
    >(LIST_ISSUES_QUERY, {
      first: limit,
      after: request.cursor,
      filter: buildIssueFilter(request),
      orderBy,
      includeArchived: request.includeArchived ?? false
    })
    const connection = raw.data?.issues
    return {
      issues: (connection?.nodes ?? []).map((issue) => ({
        ...mapIssue(issue),
        workspace: { id: entry.workspace.id, name: entry.workspace.organizationName }
      })),
      hasMore: connection?.pageInfo?.hasNextPage === true,
      nextCursor: connection?.pageInfo?.endCursor ?? undefined
    }
  })
}

function buildIssueFilter(request: LinearMcpIssueListRequest): Record<string, unknown> {
  const filter: Record<string, unknown> = {}
  if (request.team) {
    filter.team = namedFilter(request.team, true)
  }
  if (request.cycle) {
    filter.cycle = nullableNamedFilter(request.cycle)
  }
  if (request.label) {
    filter.labels = { some: namedFilter(request.label) }
  }
  if (request.query) {
    filter.searchableContent = { contains: request.query }
  }
  if (request.state) {
    filter.state = workflowStateFilter(request.state)
  }
  if (request.project) {
    filter.project = nullableProjectFilter(request.project)
  }
  if (request.release) {
    filter.releases = { some: namedFilter(request.release, false, true) }
  }
  if (request.assignee) {
    filter.assignee = nullableUserFilter(request.assignee)
  }
  if (request.delegate) {
    filter.delegate = nullableUserFilter(request.delegate)
  }
  if (request.parentId) {
    filter.parent = nullableIdFilter(request.parentId)
  }
  if (request.priority !== undefined) {
    filter.priority = { eq: request.priority }
  }
  if (request.createdAt) {
    filter.createdAt = { gte: request.createdAt }
  }
  if (request.updatedAt) {
    filter.updatedAt = { gte: request.updatedAt }
  }
  return filter
}

function namedFilter(value: string, includeKey = false, includeVersion = false): object {
  return {
    or: [
      ...(isLinearId(value) ? [{ id: { eq: value } }] : []),
      { name: { eqIgnoreCase: value } },
      ...(includeKey ? [{ key: { eqIgnoreCase: value } }] : []),
      ...(includeVersion ? [{ version: { eqIgnoreCase: value } }] : [])
    ]
  }
}

function nullableNamedFilter(value: string): object {
  return value === 'null' ? { null: true } : namedFilter(value)
}

function workflowStateFilter(value: string): object {
  const filter = namedFilter(value) as { or: object[] }
  filter.or.push({ type: { eqIgnoreCase: value } })
  return filter
}

function nullableProjectFilter(value: string): object {
  if (value === 'null') {
    return { null: true }
  }
  const filter = namedFilter(value) as { or: object[] }
  filter.or.push({ slugId: { eqIgnoreCase: value } })
  return filter
}

function nullableIdFilter(value: string): object {
  return value === 'null' ? { null: true } : { id: { eq: value } }
}

function nullableUserFilter(value: string): object {
  if (value === 'null') {
    return { null: true }
  }
  if (value.toLocaleLowerCase() === 'me') {
    return { isMe: { eq: true } }
  }
  return {
    or: [
      ...(isLinearId(value) ? [{ id: { eq: value } }] : []),
      { displayName: { eqIgnoreCase: value } },
      { name: { eqIgnoreCase: value } },
      { email: { eqIgnoreCase: value } }
    ]
  }
}

function isLinearId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function clampLimit(limit: number | undefined): number {
  return Math.min(
    Math.max(1, Math.floor(limit ?? LIST_ISSUES_DEFAULT_LIMIT)),
    LIST_ISSUES_MAX_LIMIT
  )
}

function compareIssues(
  left: LinearMcpIssueListResult['issues'][number],
  right: LinearMcpIssueListResult['issues'][number],
  orderBy: 'createdAt' | 'updatedAt'
): number {
  return (right[orderBy] ?? '').localeCompare(left[orderBy] ?? '')
}
