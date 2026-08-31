import type { LinearClient } from '@linear/sdk'
import type { LinearIssue } from '../../shared/linear/issue-types'
import type {
  LinearCollectionResult,
  LinearWorkspaceError,
  LinearWorkspaceSelection
} from '../../shared/linear/workspace-types'
import { LINEAR_ISSUE_API_PAGE_SIZE_MAX } from '../../shared/linear/issue-read-limits'
import { isEmptyLinearIssueAttributeFilter } from '../../shared/linear/issue-attribute-filter'
import { clearToken } from './linear-token-store'
import { getClients, isAuthError, type LinearClientForWorkspace } from './client'
import type {
  LinearIssueConnectionLoader,
  LinearIssueListOptions,
  LinearIssuePageRequest
} from './linear-issue-query-documents'
import {
  getListIssueConnectionLoader,
  getOldestIssueTime,
  mapRawIssueForWorkspace,
  sortAndLimitIssues,
  shouldThrowAuthError,
  sortLimitAndDescribeIssues
} from './linear-issue-query-support'
import { readLinearBeforeDeadline } from './linear-read-deadline'

export type LinearListFilter = 'assigned' | 'created' | 'all' | 'completed' | 'open'

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
  itemIds: Set<string>
  seenCursors: Set<string>
  error?: LinearWorkspaceError
  after?: string
}

// Backstops, not caps: an unbounded walk that would outlive the caller has to stop early and
// still report hasMore, so an exhausted budget stays distinguishable from a complete read.
const LINEAR_AGENT_LIST_MAX_PAGES = 200
const LINEAR_AGENT_LIST_READ_BUDGET_MS = 20_000
type LinearAgentListBudget = { deadline: number; pages: number }

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

async function readIssueConnectionPage(
  entry: LinearClientForWorkspace,
  loadConnection: LinearIssueConnectionLoader,
  client: LinearClient,
  page: LinearIssuePageRequest
): Promise<LinearIssuePageResult> {
  const connection = await loadConnection(client, page)
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
  workspaceId: LinearWorkspaceSelection | null | undefined,
  budget: LinearAgentListBudget
): Promise<void> {
  if (Date.now() >= budget.deadline || budget.pages >= LINEAR_AGENT_LIST_MAX_PAGES) {
    state.hasMore = true
    state.canPage = false
    return
  }
  budget.pages += 1
  const previousCursor = state.after
  try {
    const read = await readLinearBeforeDeadline(state.entry, budget.deadline, async (client) =>
      readIssueConnectionPage(
        state.entry,
        state.loadConnection,
        client,
        previousCursor ? { first, after: previousCursor } : { first }
      )
    )
    if (!read.completed) {
      state.hasMore = true
      state.canPage = false
      return
    }
    const page = read.value
    for (const item of page.items) {
      if (!state.itemIds.has(item.id)) {
        state.itemIds.add(item.id)
        state.items.push(item)
      }
    }
    state.hasMore = page.hasMore
    state.after = page.endCursor
    state.canPage = Boolean(
      page.hasMore &&
      page.endCursor &&
      !state.seenCursors.has(page.endCursor) &&
      page.items.length > 0
    )
    if (state.canPage && page.endCursor) {
      state.seenCursors.add(page.endCursor)
    }
  } catch (error) {
    // Why: keep pages already collected. Wiping them would report a partial read as an empty one.
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
  limit: number | null,
  workspaceId: LinearWorkspaceSelection | null | undefined,
  options?: LinearIssueListOptions
): Promise<LinearCollectionResult<LinearIssue>> {
  const states: LinearIssueWorkspacePageState[] = entries.map((entry) => ({
    entry,
    loadConnection: getListIssueConnectionLoader(filter, options),
    items: [],
    hasMore: false,
    canPage: false,
    itemIds: new Set(),
    seenCursors: new Set()
  }))
  const first =
    limit === null
      ? LINEAR_ISSUE_API_PAGE_SIZE_MAX
      : Math.min(LINEAR_ISSUE_API_PAGE_SIZE_MAX, limit)
  const budget = { deadline: Date.now() + LINEAR_AGENT_LIST_READ_BUDGET_MS, pages: 0 }

  // Why: "all workspaces" is a global sorted list. Pull one bounded page per
  // workspace first, then spend additional API calls only where unseen issues
  // can still change the global updatedAt cutoff.
  await Promise.all(
    states.map((state) => readListIssuesPageForState(state, first, workspaceId, budget))
  )

  if (limit === null) {
    while (states.some((state) => state.canPage)) {
      const liveStates = states.filter((state) => state.canPage)
      await Promise.all(
        liveStates.map((state) =>
          readListIssuesPageForState(state, LINEAR_ISSUE_API_PAGE_SIZE_MAX, workspaceId, budget)
        )
      )
    }
    return {
      items: sortAndLimitIssues(
        states.flatMap((state) => state.items),
        states.reduce((count, state) => count + state.items.length, 0)
      ),
      hasMore: states.some((state) => state.hasMore),
      errors: states.flatMap((state) => (state.error ? [state.error] : []))
    }
  }

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
    await readListIssuesPageForState(nextState, pageSize, workspaceId, budget)
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
  limit: number | null = 20,
  workspaceId?: LinearWorkspaceSelection | null,
  options?: LinearIssueListOptions
): Promise<LinearCollectionResult<LinearIssue>> {
  const effectiveLimit = limit === null ? null : Math.max(1, Math.floor(limit))
  const attributeFilter = options?.attributeFilter
  // Why: workspace-specific state/member/label ids cannot fan out safely across
  // "all" workspaces; reject before creating clients so non-UI callers cannot
  // get a misleading partial subset.
  if (
    attributeFilter &&
    !isEmptyLinearIssueAttributeFilter(attributeFilter) &&
    workspaceId === 'all'
  ) {
    throw new Error(
      'Linear attribute filters require a concrete workspace; "all" workspaces is not supported.'
    )
  }
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return { items: [] }
  }

  return readListIssuesAcrossWorkspaces(entries, filter, effectiveLimit, workspaceId, options)
}
