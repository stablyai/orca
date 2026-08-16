import { getClient, getClients } from './client'
import { apiPath, planeFetch } from './api-request'
import { arrayFromResponse, mapWorkItem, notNull } from './response-mappers'
import { listProjects } from './project-resources'
import { matchesListFilter } from './issue-query'
import { fetchProjectWorkItemPage, fetchWorkItemQueryPage } from './issue-pages'
import type {
  PlaneCollectionResult,
  PlaneCreateIssueArgs,
  PlaneIssueQuery,
  PlaneIssueUpdate,
  PlaneListFilter,
  PlaneWorkItem
} from '../../shared/plane/types'
import { parsePlaneIssueLink } from '../../shared/plane/links'

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
  const clients = getClients(instanceId as string | undefined)
  const items: PlaneWorkItem[] = []
  for (let clientIndex = 0; clientIndex < clients.length; clientIndex += 1) {
    const client = clients[clientIndex]
    const projects = await listProjects(client.instance.id)
    for (let projectIndex = 0; projectIndex < projects.length; projectIndex += 1) {
      const project = projects[projectIndex]
      let cursor: string | null = null
      do {
        const page = await fetchProjectWorkItemPage(
          client,
          project,
          cursor,
          limit,
          WORK_ITEM_EXPAND
        )
        cursor = page.nextCursor
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
        return { items: items.slice(0, limit), hasMore: cursor !== null || unvisitedProjects }
      }
    }
  }
  return { items: items.slice(0, limit) }
}

async function listIssuesByQuery(
  query: PlaneIssueQuery,
  limit: number,
  instanceId?: string
): Promise<PlaneCollectionResult<PlaneWorkItem>> {
  const items: PlaneWorkItem[] = []
  for (const client of getClients(instanceId as string | undefined)) {
    const allProjects = await listProjects(client.instance.id)
    const projects = query.projectId
      ? allProjects.filter((project) => project.id === query.projectId)
      : allProjects
    for (const project of projects) {
      let cursor: string | null = null
      do {
        const page = await fetchWorkItemQueryPage(
          client,
          project,
          query,
          cursor,
          limit,
          WORK_ITEM_EXPAND
        )
        cursor = page.nextCursor
        items.push(...page.items.map((item) => mapWorkItem(client, project, item)).filter(notNull))
      } while (cursor && items.length < limit)
      if (items.length >= limit) {
        return { items: items.slice(0, limit), hasMore: cursor !== null }
      }
    }
  }
  return { items: items.slice(0, limit) }
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

export async function getIssue(
  identifierOrId: string,
  instanceId?: string
): Promise<PlaneWorkItem | null> {
  const parsed = parsePlaneIssueLink(identifierOrId)
  for (const client of getClients(instanceId as string | undefined)) {
    const issue = parsed
      ? await readIssueByIdentifier(client, parsed.identifier)
      : await readIssueById(client, identifierOrId)
    if (issue) {
      return issue
    }
  }
  return null
}

export async function createIssue(
  args: PlaneCreateIssueArgs
): Promise<
  | { ok: true; id: string; identifier: string; title: string; url: string }
  | { ok: false; error: string }
> {
  try {
    const client = getClient(args.instanceId)
    const body = JSON.stringify({
      name: args.title,
      description: args.description,
      description_html: args.description,
      state: args.stateId,
      assignees: args.assigneeIds,
      labels: args.labelIds,
      priority: args.priority,
      cycle: args.cycleId,
      module: args.moduleId,
      type_id: args.typeId,
      estimate_point: args.estimatePoint,
      external_source: args.externalSource,
      external_id: args.externalId
    })
    const data = await planeFetch<unknown>(
      client,
      apiPath(client, `/projects/${encodeURIComponent(args.projectId)}/work-items/`),
      { method: 'POST', body }
    )
    const project =
      (await listProjects(client.instance.id)).find((item) => item.id === args.projectId) ?? null
    const issue = mapWorkItem(client, project, data)
    if (!issue) {
      throw new Error('Plane did not return the created work item')
    }
    return {
      ok: true,
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function updateIssue(
  identifierOrId: string,
  updates: PlaneIssueUpdate,
  instanceId?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const client = getClient(instanceId)
    const issue = await getIssue(identifierOrId, client.instance.id)
    if (!issue) {
      throw new Error('Plane work item not found')
    }
    await planeFetch<unknown>(
      client,
      apiPath(
        client,
        `/projects/${encodeURIComponent(issue.project.id)}/work-items/${encodeURIComponent(issue.id)}/`
      ),
      {
        method: 'PATCH',
        body: JSON.stringify({
          name: updates.title,
          description: updates.description,
          description_html: updates.description,
          state: updates.stateId,
          assignees: updates.assigneeIds,
          labels: updates.labelIds,
          priority: updates.priority,
          cycle: updates.cycleId,
          module: updates.moduleId,
          type_id: updates.typeId,
          estimate_point: updates.estimatePoint
        })
      }
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function deleteIssue(
  identifierOrId: string,
  instanceId?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const client = getClient(instanceId)
    const issue = await getIssue(identifierOrId, client.instance.id)
    if (!issue) {
      throw new Error('Plane work item not found')
    }
    await planeFetch<unknown>(
      client,
      apiPath(
        client,
        `/projects/${encodeURIComponent(issue.project.id)}/work-items/${encodeURIComponent(issue.id)}/`
      ),
      { method: 'DELETE' }
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function readIssueByIdentifier(
  client: PlaneClient,
  identifier: string
): Promise<PlaneWorkItem | null> {
  try {
    const params = new URLSearchParams({ expand: WORK_ITEM_EXPAND })
    const data = await planeFetch<unknown>(
      client,
      apiPath(client, `/work-items/${encodeURIComponent(identifier)}/?${params}`)
    )
    return mapWorkItem(client, null, data)
  } catch {
    return null
  }
}

async function readIssueById(client: PlaneClient, id: string): Promise<PlaneWorkItem | null> {
  const projects = await listProjects(client.instance.id)
  for (const project of projects) {
    try {
      const data = await planeFetch<unknown>(
        client,
        apiPath(
          client,
          `/projects/${encodeURIComponent(project.id)}/work-items/${encodeURIComponent(id)}/?${new URLSearchParams({ expand: WORK_ITEM_EXPAND })}`
        )
      )
      const issue = mapWorkItem(client, project, data)
      if (issue) {
        return issue
      }
    } catch {}
  }
  return null
}

export type { PlaneListFilter }
