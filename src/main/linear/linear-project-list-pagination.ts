import type { LinearProjectSummary } from '../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearWorkspaceError,
  LinearWorkspaceSelection
} from '../../shared/linear/workspace-types'
import { clearToken } from './linear-token-store'
import { getClients, isAuthError, type LinearClientForWorkspace } from './client'
import { PROJECTS_QUERY, SEARCH_PROJECTS_QUERY } from './linear-project-graphql'
import type { LinearRawVariables, ProjectConnectionResponse } from './linear-project-nodes'
import {
  LINEAR_PROJECT_API_PAGE_SIZE_MAX,
  mapProjectForWorkspace,
  shouldFailWholeRequest,
  workspaceError
} from './linear-project-models'
import { readLinearBeforeDeadline } from './linear-read-deadline'

// Backstops, not caps: an unbounded walk that would outlive the caller has to stop early and
// still report hasMore, so an exhausted budget stays distinguishable from a complete read.
const LINEAR_AGENT_PROJECT_MAX_PAGES = 200
const LINEAR_AGENT_PROJECT_READ_BUDGET_MS = 20_000

type ProjectListPageState = {
  entry: LinearClientForWorkspace
  items: LinearProjectSummary[]
  hasMore: boolean
  canPage: boolean
  itemIds: Set<string>
  seenCursors: Set<string>
  after?: string
  error?: LinearWorkspaceError
}

type ProjectListBudget = { deadline: number; pages: number }

async function readProjectListPage(
  state: ProjectListPageState,
  query: string | undefined,
  first: number,
  workspaceId: LinearWorkspaceSelection | null | undefined,
  budget: ProjectListBudget
): Promise<void> {
  if (Date.now() >= budget.deadline || budget.pages >= LINEAR_AGENT_PROJECT_MAX_PAGES) {
    state.hasMore = true
    state.canPage = false
    return
  }
  budget.pages += 1
  const previousCursor = state.after
  try {
    const variables = query
      ? { term: query, first, ...(previousCursor ? { after: previousCursor } : {}) }
      : {
          first,
          ...(previousCursor ? { after: previousCursor } : {}),
          orderBy: 'updatedAt'
        }
    const read = await readLinearBeforeDeadline(state.entry, budget.deadline, (client) =>
      client.client.rawRequest<ProjectConnectionResponse, LinearRawVariables>(
        query ? SEARCH_PROJECTS_QUERY : PROJECTS_QUERY,
        variables
      )
    )
    if (!read.completed) {
      state.hasMore = true
      state.canPage = false
      return
    }
    const result = read.value
    const connection = query ? result.data?.searchProjects : result.data?.projects
    const nodes = connection?.nodes ?? []
    for (const node of nodes) {
      if (!state.itemIds.has(node.id)) {
        state.itemIds.add(node.id)
        state.items.push(mapProjectForWorkspace(state.entry, node))
      }
    }
    state.hasMore = Boolean(connection?.pageInfo?.hasNextPage)
    state.after = connection?.pageInfo?.endCursor ?? undefined
    state.canPage = Boolean(
      state.hasMore && state.after && !state.seenCursors.has(state.after) && nodes.length > 0
    )
    if (state.canPage && state.after) {
      state.seenCursors.add(state.after)
    }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(state.entry.workspace.id)
    } else {
      console.warn('[linear] project list read failed:', error)
    }
    if (shouldFailWholeRequest(workspaceId)) {
      throw error
    }
    state.error = workspaceError(state.entry, error)
    state.canPage = false
  }
}

export async function readProjectListPages(
  query: string | undefined,
  limit: number | null,
  workspaceId: LinearWorkspaceSelection | null | undefined
): Promise<LinearCollectionResult<LinearProjectSummary>> {
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return { items: [] }
  }
  const states: ProjectListPageState[] = entries.map((entry) => ({
    entry,
    items: [],
    hasMore: false,
    canPage: false,
    itemIds: new Set(),
    seenCursors: new Set()
  }))
  const budget = { deadline: Date.now() + LINEAR_AGENT_PROJECT_READ_BUDGET_MS, pages: 0 }
  const first =
    limit === null
      ? LINEAR_PROJECT_API_PAGE_SIZE_MAX
      : Math.min(LINEAR_PROJECT_API_PAGE_SIZE_MAX, limit)
  await Promise.all(
    states.map((state) => readProjectListPage(state, query, first, workspaceId, budget))
  )

  if (limit === null) {
    while (states.some((state) => state.canPage)) {
      await Promise.all(
        states
          .filter((state) => state.canPage)
          .map((state) =>
            readProjectListPage(state, query, LINEAR_PROJECT_API_PAGE_SIZE_MAX, workspaceId, budget)
          )
      )
    }
  } else {
    while (states.reduce((count, state) => count + state.items.length, 0) < limit) {
      const state = states.find((candidate) => candidate.canPage)
      if (!state) {
        break
      }
      const returned = states.reduce((count, candidate) => count + candidate.items.length, 0)
      await readProjectListPage(
        state,
        query,
        Math.min(LINEAR_PROJECT_API_PAGE_SIZE_MAX, limit - returned),
        workspaceId,
        budget
      )
    }
  }

  const allItems = states.flatMap((state) => state.items)
  const items = limit === null ? allItems : allItems.slice(0, limit)
  return {
    items,
    hasMore: states.some((state) => state.hasMore) || items.length < allItems.length,
    errors: states.flatMap((state) => (state.error ? [state.error] : []))
  }
}
