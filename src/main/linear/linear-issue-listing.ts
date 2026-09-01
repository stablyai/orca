import type { LinearIssue } from '../../shared/linear/issue-types'
import type {
  LinearCollectionResult,
  LinearWorkspaceError,
  LinearWorkspaceSelection
} from '../../shared/linear/workspace-types'
import {
  LINEAR_ISSUE_API_PAGE_SIZE_MAX,
  clampLinearIssueListLimit
} from '../../shared/linear/issue-read-limits'
import { isEmptyLinearIssueAttributeFilter } from '../../shared/linear/issue-attribute-filter'
import { acquire, release } from './linear-request-concurrency'
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
  readIssueConnectionPages,
  shouldThrowAuthError,
  sortLimitAndDescribeIssues
} from './linear-issue-query-support'

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
  options?: LinearIssueListOptions
): Promise<LinearCollectionResult<LinearIssue>> {
  await acquire()
  try {
    return await readIssueConnectionPages(
      entry,
      limit,
      getListIssueConnectionLoader(entry, filter, options)
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
  options?: LinearIssueListOptions
): Promise<LinearCollectionResult<LinearIssue>> {
  const states: LinearIssueWorkspacePageState[] = entries.map((entry) => ({
    entry,
    loadConnection: getListIssueConnectionLoader(entry, filter, options),
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
  options?: LinearIssueListOptions
): Promise<LinearCollectionResult<LinearIssue>> {
  const effectiveLimit = clampLinearIssueListLimit(limit)
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

  if (entries.length === 1) {
    return readListIssuesForWorkspace(entries[0], filter, effectiveLimit, workspaceId, options)
  }

  return readListIssuesAcrossWorkspaces(entries, filter, effectiveLimit, workspaceId, options)
}
