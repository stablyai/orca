import { apiPath, planeFetch } from './api-request'
import { buildFilters, buildPql, normalizeOrderBy } from './issue-query'
import { arrayFromResponse } from './response-mappers'
import type { getClient } from './client'
import type { PlaneIssueQuery, PlaneProject } from '../../shared/plane/types'

type PlaneClient = ReturnType<typeof getClient>

const PAGE_SIZE_MAX = 100

export type PlanePage = {
  items: unknown[]
  nextCursor: string | null
  hasNext: boolean
  totalPages?: number
  totalResults?: number
}

export async function fetchProjectWorkItemPage(
  client: PlaneClient,
  project: PlaneProject,
  cursor: string | null,
  limit: number,
  expand: string
): Promise<PlanePage> {
  const query = new URLSearchParams({
    per_page: String(Math.min(Math.max(1, limit), PAGE_SIZE_MAX)),
    expand,
    order_by: '-updated_at'
  })
  if (cursor) {
    query.set('cursor', cursor)
  }
  const data = await planeFetch<unknown>(
    client,
    apiPath(client, `/projects/${encodeURIComponent(project.id)}/work-items/?${query}`)
  )
  return mapPlanePage(data)
}

export async function fetchWorkItemQueryPage(
  client: PlaneClient,
  project: PlaneProject | null,
  query: PlaneIssueQuery,
  cursor: string | null,
  limit: number,
  expand: string
): Promise<PlanePage> {
  const params = new URLSearchParams({
    per_page: String(Math.min(Math.max(1, limit), PAGE_SIZE_MAX)),
    expand,
    order_by: normalizeOrderBy(query.orderBy)
  })
  const pql = buildPql(query)
  const filters = buildFilters(client, query)
  if (query.query?.trim()) {
    params.set('search', query.query.trim())
  }
  if (filters) {
    params.set('filters', JSON.stringify(filters))
  }
  if (pql) {
    params.set('pql', pql)
  }
  if (cursor) {
    params.set('cursor', cursor)
  }
  const data = await planeFetch<unknown>(
    client,
    project
      ? apiPath(client, `/projects/${encodeURIComponent(project.id)}/work-items/?${params}`)
      : apiPath(client, `/work-items/?${params}`)
  )
  return mapPlanePage(data)
}

function mapPlanePage(data: unknown): PlanePage {
  const raw = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  return {
    items: arrayFromResponse(data),
    nextCursor: typeof raw.next_cursor === 'string' && raw.next_cursor ? raw.next_cursor : null,
    hasNext: raw.next_page_results === true,
    totalPages: numberField(raw.total_pages),
    totalResults: numberField(raw.total_results ?? raw.total_count)
  }
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
