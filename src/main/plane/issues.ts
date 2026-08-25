import { getClients } from './client'
import { apiPath, planeFetch } from './api-request'
import { arrayFromResponse, mapWorkItem, notNull } from './response-mappers'
import { listProjects } from './project-resources'
import { matchesListFilter } from './issue-query'
import { fetchProjectWorkItemPage, fetchWorkItemQueryPage } from './issue-pages'
export { createIssue, deleteIssue, getIssue, updateIssue } from './issue-mutations'
import type { getClient } from './client'
import type {
  PlaneCollectionResult,
  PlaneIssueQuery,
  PlaneListFilter,
  PlaneProject,
  PlaneWorkItem
} from '../../shared/plane/types'

type PlaneClient = ReturnType<typeof getClient>
const WORK_ITEM_EXPAND = 'assignees,labels,state,project,cycle,module,type'

export async function listIssues(
  filterOrQuery: PlaneListFilter | PlaneIssueQuery = 'all',
  limit = 30,
  instanceId?: string
): Promise<PlaneCollectionResult<PlaneWorkItem>> {
  if (typeof filterOrQuery !== 'string') {
    return listIssuesByQuery(filterOrQuery, limit, instanceId)
  }
  const filter = filterOrQuery
  if (filter !== 'all') {
    return listIssuesByQuery({ preset: filter }, limit, instanceId)
  }
  const clients = getClients(instanceId as string | undefined)
  const items: PlaneWorkItem[] = []
  let totalResults = 0
  let sawTotalResults = false
  for (let clientIndex = 0; clientIndex < clients.length; clientIndex += 1) {
    const client = clients[clientIndex]
    const projects = await listProjects(client.instance.id)
    for (let projectIndex = 0; projectIndex < projects.length; projectIndex += 1) {
      const project = projects[projectIndex]
      let cursor: string | null = null
      do {
        const pageCursor = cursor
        const page = await fetchProjectWorkItemPage(
          client,
          project,
          cursor,
          limit,
          WORK_ITEM_EXPAND
        )
        cursor = nextPageCursor(pageCursor, page)
        if (page.totalResults !== undefined && pageCursor === null) {
          totalResults += page.totalResults
          sawTotalResults = true
        }
        items.push(
          ...page.items
            .map((item) => mapWorkItem(client, project, item))
            .filter(notNull)
            .filter((item) => matchesListFilter(client, item, filter))
        )
      } while (cursor && items.length < limit)
      if (items.length >= limit) {
        const unvisitedProjects =
          projectIndex < projects.length - 1 || clientIndex < clients.length - 1
        return collectionResult(
          items,
          limit,
          cursor !== null || unvisitedProjects,
          sawTotalResults ? totalResults : undefined
        )
      }
    }
  }
  return collectionResult(items, limit, false, sawTotalResults ? totalResults : undefined)
}

async function listIssuesByQuery(
  query: PlaneIssueQuery,
  limit: number,
  instanceId?: string
): Promise<PlaneCollectionResult<PlaneWorkItem>> {
  const items: PlaneWorkItem[] = []
  const clients = getClients(instanceId as string | undefined)
  let totalPages: number | undefined
  let totalResults: number | undefined
  for (let clientIndex = 0; clientIndex < clients.length; clientIndex += 1) {
    const client = clients[clientIndex]
    const project = await singleProjectForQuery(client, query)
    let cursor: string | null = null
    do {
      const pageCursor = cursor
      const page = await fetchWorkItemQueryPage(
        client,
        project,
        query,
        cursor,
        limit,
        WORK_ITEM_EXPAND
      )
      cursor = nextPageCursor(pageCursor, page)
      if (page.totalResults !== undefined && pageCursor === null) {
        totalResults = page.totalResults
      }
      if (page.totalPages !== undefined && pageCursor === null) {
        totalPages = page.totalPages
      }
      items.push(...page.items.map((item) => mapWorkItem(client, project, item)).filter(notNull))
    } while (cursor && items.length < limit)
    if (items.length >= limit) {
      return collectionResult(
        items,
        limit,
        hasMoreIssues(items.length, cursor, totalResults) || clientIndex < clients.length - 1,
        totalResults,
        totalPages
      )
    }
  }
  return collectionResult(items, limit, false, totalResults, totalPages)
}

function hasMoreIssues(
  loadedCount: number,
  cursor: string | null,
  totalResults: number | undefined
): boolean {
  return cursor !== null || (totalResults !== undefined && loadedCount < totalResults)
}

function collectionResult(
  items: PlaneWorkItem[],
  limit: number,
  hasMore: boolean,
  totalResults?: number,
  totalPages?: number
): PlaneCollectionResult<PlaneWorkItem> {
  return {
    items: items.slice(0, limit),
    ...(hasMore ? { hasMore: true } : {}),
    ...(totalPages !== undefined
      ? {
          totalPages
        }
      : {}),
    ...(totalResults !== undefined
      ? {
          totalResults
        }
      : {})
  }
}

async function singleProjectForQuery(
  client: PlaneClient,
  query: PlaneIssueQuery
): Promise<PlaneProject | null> {
  if (query.projectId) {
    const projects = await listProjects(client.instance.id)
    return projects.find((project) => project.id === query.projectId) ?? null
  }
  if (query.projectIds?.length === 1) {
    const projects = await listProjects(client.instance.id)
    return projects.find((project) => project.id === query.projectIds?.[0]) ?? null
  }
  return null
}

function nextPageCursor(
  currentCursor: string | null,
  page: { items: unknown[]; nextCursor: string | null }
): string | null {
  if (page.items.length === 0 || !page.nextCursor || page.nextCursor === currentCursor) {
    return null
  }
  return page.nextCursor
}

export async function searchIssues(
  query: string,
  limit = 20,
  instanceId?: string
): Promise<PlaneWorkItem[]> {
  const items: PlaneWorkItem[] = []
  for (const client of getClients(instanceId as string | undefined)) {
    const params = new URLSearchParams({
      search: query,
      limit: String(limit),
      workspace_search: 'true',
      expand: WORK_ITEM_EXPAND
    })
    const data = await planeFetch<unknown>(client, apiPath(client, `/work-items/search/?${params}`))
    items.push(
      ...arrayFromResponse(data)
        .map((item) => mapWorkItem(client, null, item))
        .filter(notNull)
    )
  }
  return items.slice(0, limit)
}

export type { PlaneListFilter }
