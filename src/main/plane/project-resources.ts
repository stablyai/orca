import { getClient, type PlaneClientForInstance } from './client'
import { apiPath, planeFetch } from './api-request'
import { mapCycle, mapEstimate, mapModule, mapWorkItemType } from './project-resource-mappers'
import {
  arrayFromResponse,
  mapLabel,
  mapMember,
  mapProject,
  mapState,
  notNull
} from './response-mappers'
import type {
  PlaneCycle,
  PlaneEstimate,
  PlaneLabel,
  PlaneMember,
  PlaneModule,
  PlaneProject,
  PlaneState,
  PlaneWorkItemType
} from '../../shared/plane/types'

const PAGE_SIZE_MAX = 100

export async function listProjects(instanceId?: string): Promise<PlaneProject[]> {
  const client = getClient(instanceId)
  const items: PlaneProject[] = []
  let cursor: string | null = null
  do {
    const query = new URLSearchParams({ per_page: String(PAGE_SIZE_MAX) })
    if (cursor) {
      query.set('cursor', cursor)
    }
    const data = await planeFetch<unknown>(client, apiPath(client, `/projects/?${query}`))
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    items.push(
      ...arrayFromResponse(data)
        .map((item) => mapProject(client, item))
        .filter(notNull)
    )
    cursor =
      raw.next_page_results === true && typeof raw.next_cursor === 'string' ? raw.next_cursor : null
  } while (cursor)
  return items
}

export async function listStates(projectId: string, instanceId?: string): Promise<PlaneState[]> {
  const client = getClient(instanceId)
  const data = await planeFetch<unknown>(
    client,
    apiPath(client, `/projects/${encodeURIComponent(projectId)}/states/`)
  )
  return arrayFromResponse(data).map(mapState).filter(notNull)
}

export async function listLabels(projectId: string, instanceId?: string): Promise<PlaneLabel[]> {
  const client = getClient(instanceId)
  const data = await planeFetch<unknown>(
    client,
    apiPath(client, `/projects/${encodeURIComponent(projectId)}/labels/`)
  )
  return arrayFromResponse(data).map(mapLabel).filter(notNull)
}

export async function listMembers(instanceId?: string): Promise<PlaneMember[]> {
  const client = getClient(instanceId)
  const data = await planeFetch<unknown>(client, apiPath(client, '/members/'))
  return arrayFromResponse(data).map(mapMember).filter(notNull)
}

export async function listCycles(projectId: string, instanceId?: string): Promise<PlaneCycle[]> {
  return listProjectResource(projectId, instanceId, 'cycles', mapCycle)
}

export async function listModules(projectId: string, instanceId?: string): Promise<PlaneModule[]> {
  return listProjectResource(projectId, instanceId, 'modules', mapModule)
}

export async function listWorkItemTypes(
  projectId: string,
  instanceId?: string
): Promise<PlaneWorkItemType[]> {
  return listProjectResource(projectId, instanceId, 'work-item-types', mapWorkItemType)
}

export async function listEstimates(
  projectId: string,
  instanceId?: string
): Promise<PlaneEstimate[]> {
  try {
    return await listProjectResource(projectId, instanceId, 'estimates', mapEstimate)
  } catch (error) {
    if (error instanceof Error && /Plane API 404:.*Estimate not found/.test(error.message)) {
      return []
    }
    throw error
  }
}

async function listProjectResource<T>(
  projectId: string,
  instanceId: string | undefined,
  resource: string,
  map: (client: PlaneClientForInstance, projectId: string, item: unknown) => T | null
): Promise<T[]> {
  const client = getClient(instanceId)
  const items: T[] = []
  let cursor: string | null = null
  do {
    const query = new URLSearchParams({ per_page: String(PAGE_SIZE_MAX) })
    if (cursor) {
      query.set('cursor', cursor)
    }
    const data = await planeFetch<unknown>(
      client,
      apiPath(client, `/projects/${encodeURIComponent(projectId)}/${resource}/?${query}`)
    )
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    items.push(
      ...arrayFromResponse(data)
        .map((item) => map(client, projectId, item))
        .filter(notNull)
    )
    cursor =
      raw.next_page_results === true && typeof raw.next_cursor === 'string' ? raw.next_cursor : null
  } while (cursor)
  return items
}
