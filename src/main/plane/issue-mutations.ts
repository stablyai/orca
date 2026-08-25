import { getClient, getClients } from './client'
import { apiPath, planeFetch } from './api-request'
import { listProjects } from './project-resources'
import { mapWorkItem } from './response-mappers'
import { parsePlaneIssueLink } from '../../shared/plane/links'
import type {
  PlaneCreateIssueArgs,
  PlaneIssueUpdate,
  PlaneWorkItem
} from '../../shared/plane/types'

type PlaneClient = ReturnType<typeof getClient>

const WORK_ITEM_EXPAND = 'assignees,labels,state,project,cycle,module,type'

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
    const data = await planeFetch<unknown>(
      client,
      apiPath(client, `/projects/${encodeURIComponent(args.projectId)}/work-items/`),
      { method: 'POST', body: JSON.stringify(createIssuePayload(args)) }
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
    await planeFetch<unknown>(client, issuePath(client, issue), {
      method: 'PATCH',
      body: JSON.stringify(updateIssuePayload(updates))
    })
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
    await planeFetch<unknown>(client, issuePath(client, issue), { method: 'DELETE' })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function createIssuePayload(args: PlaneCreateIssueArgs): Record<string, unknown> {
  return {
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
  }
}

function updateIssuePayload(updates: PlaneIssueUpdate): Record<string, unknown> {
  return {
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
  }
}

function issuePath(client: PlaneClient, issue: PlaneWorkItem): string {
  return apiPath(
    client,
    `/projects/${encodeURIComponent(issue.project.id)}/work-items/${encodeURIComponent(issue.id)}/`
  )
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
  } catch (error) {
    if (!isPlaneNotFoundError(error)) {
      throw error
    }
    return null
  }
}

async function readIssueById(client: PlaneClient, id: string): Promise<PlaneWorkItem | null> {
  const projects = await listProjects(client.instance.id)
  for (const project of projects) {
    try {
      const params = new URLSearchParams({ expand: WORK_ITEM_EXPAND })
      const data = await planeFetch<unknown>(
        client,
        apiPath(
          client,
          `/projects/${encodeURIComponent(project.id)}/work-items/${encodeURIComponent(id)}/?${params}`
        )
      )
      const issue = mapWorkItem(client, project, data)
      if (issue) {
        return issue
      }
    } catch (error) {
      if (!isPlaneNotFoundError(error)) {
        throw error
      }
    }
  }
  return null
}

function isPlaneNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Plane API 404:')
}
