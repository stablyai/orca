import type {
  LinearMcpIssueListRequest,
  LinearMcpIssueListResult
} from '../../shared/linear/agent-access'
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
import { encodeIssueListCursor, resolveIssueListCursor } from './mcp-issue-list-cursor'
import { buildIssueFilter } from './mcp-issue-list-filter'

// Why: `--limit` is opt-in, so the default read walks every page instead of quietly cutting
// the answer off. Linear caps `first` at 250. The budget and page ceiling are backstops, not
// caps: the CLI abandons an RPC at 60s, so a walk that would outlive it has to stop early and
// say `truncated` with a continuation cursor rather than fail the whole command.
const LIST_ISSUES_PAGE_SIZE = 250
const LIST_ISSUES_MAX_PAGES = 200
const LIST_ISSUES_READ_BUDGET_MS = 20_000

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

// limit null means unbounded; the deadline still applies.
type IssueListReadBudget = { limit: number | null; deadline: number }

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
  const pagination = resolveIssueListCursor(request)
  const limit = resolveLimit(request.limit)
  const orderBy = request.orderBy ?? 'updatedAt'
  const { entries, failures: entryFailures } = getIssueListEntries(pagination.workspaceId)
  if (entries.length === 0) {
    if (entryFailures[0]) {
      throw entryFailures[0].error
    }
    throw linearError('linear_not_connected', 'Linear is not connected.', {
      nextSteps: ['Connect Linear from Orca settings, then retry the issue list.']
    })
  }
  const pagedRequest = {
    ...request,
    cursor: pagination.linearCursor,
    workspaceId: pagination.workspaceId
  }
  // One deadline for the whole call, so fanning out over many workspaces cannot multiply it.
  const deadline = Date.now() + LIST_ISSUES_READ_BUDGET_MS
  const { pages, failures } = await readIssueListWorkspaces(
    entries,
    pagedRequest,
    { limit, deadline },
    orderBy,
    entryFailures
  )
  const issues = pages.flatMap((page) => page.issues)
  let hasMore = pages.some((page) => page.hasMore)

  issues.sort((left, right) => compareIssues(left, right, orderBy))
  if (limit !== null && issues.length > limit) {
    hasMore = true
    issues.length = limit
  }
  const workspaceId = pagination.workspaceId === 'all' ? 'all' : entries[0].workspace.id
  return {
    issues,
    truncated: hasMore,
    meta: {
      limit,
      returned: issues.length,
      hasMore,
      ...(hasMore && workspaceId !== 'all' && pages.length === 1 && pages[0].nextCursor
        ? { nextCursor: encodeIssueListCursor(workspaceId, pages[0].nextCursor) }
        : {}),
      orderBy,
      workspaceId,
      partial: failures.length > 0,
      workspaceErrors: failures.map(({ workspace, code, message }) => ({
        workspace,
        code,
        message
      }))
    }
  }
}

function getIssueListEntries(workspaceId?: (string & {}) | 'all'): {
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
  budget: IssueListReadBudget,
  orderBy: 'createdAt' | 'updatedAt',
  initialFailures: WorkspaceReadFailure[]
): Promise<{ pages: WorkspaceIssuePage[]; failures: WorkspaceReadFailure[] }> {
  if (request.workspaceId !== 'all') {
    return {
      pages: [await readIssueListWorkspace(entries[0], request, budget, orderBy)],
      failures: []
    }
  }

  const settled = await Promise.allSettled(
    entries.map((entry) => readIssueListWorkspace(entry, request, budget, orderBy))
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
  { limit, deadline }: IssueListReadBudget,
  orderBy: 'createdAt' | 'updatedAt'
): Promise<WorkspaceIssuePage> {
  const filter = buildIssueFilter(request)
  const issues: WorkspaceIssuePage['issues'] = []
  let after = request.cursor
  let hasMore = false
  let nextCursor: string | undefined
  for (let page = 0; page < LIST_ISSUES_MAX_PAGES; page += 1) {
    const first =
      limit === null
        ? LIST_ISSUES_PAGE_SIZE
        : Math.min(limit - issues.length, LIST_ISSUES_PAGE_SIZE)
    // Each page takes its own concurrency slot so a long walk cannot starve other reads.
    const connection = await withLinearRead(entry, async () => {
      const raw = await entry.client.client.rawRequest<
        RawListIssuesResponse,
        Record<string, unknown>
      >(LIST_ISSUES_QUERY, {
        first,
        after,
        filter,
        orderBy,
        includeArchived: request.includeArchived ?? false
      })
      return raw.data?.issues
    })
    for (const issue of connection?.nodes ?? []) {
      issues.push({
        ...mapIssue(issue),
        workspace: { id: entry.workspace.id, name: entry.workspace.organizationName }
      })
    }
    hasMore = connection?.pageInfo?.hasNextPage === true
    nextCursor = connection?.pageInfo?.endCursor ?? undefined
    if (!hasMore || !nextCursor) {
      break
    }
    if (limit !== null && issues.length >= limit) {
      break
    }
    if (Date.now() >= deadline) {
      break
    }
    after = nextCursor
  }
  return { issues, hasMore, nextCursor }
}

// null means unbounded: read until Linear stops handing out pages.
function resolveLimit(limit: number | undefined): number | null {
  return limit === undefined ? null : Math.max(1, Math.floor(limit))
}

function compareIssues(
  left: LinearMcpIssueListResult['issues'][number],
  right: LinearMcpIssueListResult['issues'][number],
  orderBy: 'createdAt' | 'updatedAt'
): number {
  return (right[orderBy] ?? '').localeCompare(left[orderBy] ?? '')
}
