import type {
  PlaneIssue,
  PlaneIssueFilter,
  PlaneIssueUpdate,
  PlaneMutationResult,
  PlanePriority
} from '../../shared/plane-types'
import { buildPlaneIssueUrl } from '../../shared/plane/links'
import { planeRequest } from './authenticated-request'
import { getClient } from './client'
import {
  normalizePriority,
  normalizeStateGroup,
  type RawPlaneIssue,
  userFromRaw
} from './plane-issue-mappers'
import { listProjects } from './plane-projects'

export { listProjects, listStates } from './plane-projects'
export { addIssueComment, getIssueComments } from './plane-comments'

function mapRawIssue(
  item: RawPlaneIssue,
  instanceUrl: string,
  workspaceSlug: string,
  projectId: string
): PlaneIssue {
  const projectIdentifier = item.project_detail?.identifier ?? 'ISSUE'
  const key = `${projectIdentifier}-${item.sequence_id}`
  const url = buildPlaneIssueUrl(instanceUrl, workspaceSlug, projectId, item.id)

  return {
    id: item.id,
    sequenceId: item.sequence_id,
    key,
    title: item.name,
    description: item.description_html || item.description,
    url,
    workspaceSlug,
    projectId,
    project: {
      id: projectId,
      identifier: projectIdentifier,
      name: item.project_detail?.name ?? projectIdentifier,
      workspaceSlug
    },
    state: {
      id: item.state_detail?.id ?? item.state,
      name: item.state_detail?.name ?? 'Unknown',
      group: normalizeStateGroup(item.state_detail?.group ?? 'unstarted'),
      color: item.state_detail?.color ?? '#808080',
      sequence: item.state_detail?.sequence ?? 0
    },
    priority: normalizePriority(item.priority),
    labels: item.labels_list?.map((l) => l.name) ?? [],
    assignees: item.assignee_details?.map(userFromRaw) ?? [],
    createdAt: item.created_at,
    updatedAt: item.updated_at
  }
}

export async function listIssues(args: {
  workspaceSlug?: string
  projectId?: string
  filter?: PlaneIssueFilter
  limit?: number
}): Promise<PlaneIssue[]> {
  const client = getClient()
  if (!client) {
    return []
  }
  const slug = args.workspaceSlug || client.activeWorkspaceSlug
  if (!slug) {
    return []
  }

  let projectId = args.projectId
  if (!projectId) {
    const projects = await listProjects(slug)
    if (projects.length === 0) {
      return []
    }
    projectId = projects[0]?.id
  }
  if (!projectId) {
    return []
  }

  try {
    const raw = await planeRequest<RawPlaneIssue[] | { results?: RawPlaneIssue[] }>(
      client.instanceUrl,
      client.apiToken,
      `/api/v1/workspaces/${slug}/projects/${projectId}/issues/`,
      { params: { per_page: args.limit ?? 50 } }
    )
    const list = Array.isArray(raw) ? raw : (raw.results ?? [])
    return list.map((item) => mapRawIssue(item, client.instanceUrl, slug, item.project))
  } catch (error) {
    console.error('[plane] failed to list issues:', error)
    return []
  }
}

export async function getIssue(
  workspaceSlug: string,
  projectId: string,
  issueId: string
): Promise<PlaneIssue | null> {
  const client = getClient()
  if (!client) {
    return null
  }
  try {
    const item = await planeRequest<RawPlaneIssue>(
      client.instanceUrl,
      client.apiToken,
      `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/`
    )
    return mapRawIssue(item, client.instanceUrl, workspaceSlug, projectId)
  } catch (error) {
    console.error('[plane] failed to get issue:', error)
    return null
  }
}

export async function updateIssue(args: {
  workspaceSlug: string
  projectId: string
  issueId: string
  update: PlaneIssueUpdate
}): Promise<PlaneMutationResult> {
  const client = getClient()
  if (!client) {
    return { ok: false, error: 'Plane is not connected' }
  }

  const payload: Record<string, unknown> = {}
  if (args.update.stateId) {
    payload.state = args.update.stateId
  }
  if (args.update.priority) {
    payload.priority = args.update.priority
  }
  if (args.update.title) {
    payload.name = args.update.title
  }
  if (args.update.description) {
    payload.description = args.update.description
  }

  try {
    await planeRequest(
      client.instanceUrl,
      client.apiToken,
      `/api/v1/workspaces/${args.workspaceSlug}/projects/${args.projectId}/issues/${args.issueId}/`,
      { method: 'PATCH', body: payload }
    )
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update issue'
    return { ok: false, error: message }
  }
}

export async function createIssue(args: {
  workspaceSlug?: string
  projectId: string
  title: string
  description?: string
  stateId?: string
  priority?: PlanePriority
  assigneeIds?: string[]
}): Promise<{ ok: boolean; issue?: PlaneIssue; error?: string }> {
  const client = getClient()
  if (!client) {
    return { ok: false, error: 'Plane is not connected' }
  }
  const slug = args.workspaceSlug || client.activeWorkspaceSlug
  if (!slug) {
    return { ok: false, error: 'No active Plane workspace selected' }
  }

  const payload: Record<string, unknown> = { name: args.title }
  if (args.description) {
    payload.description_html = `<p>${args.description}</p>`
  }
  if (args.stateId) {
    payload.state = args.stateId
  }
  if (args.priority && args.priority !== 'none') {
    payload.priority = args.priority
  }
  if (args.assigneeIds && args.assigneeIds.length > 0) {
    payload.assignees = args.assigneeIds
  }

  try {
    const raw = await planeRequest<RawPlaneIssue>(
      client.instanceUrl,
      client.apiToken,
      `/api/v1/workspaces/${slug}/projects/${args.projectId}/issues/`,
      { method: 'POST', body: payload }
    )
    return {
      ok: true,
      issue: mapRawIssue(raw, client.instanceUrl, slug, args.projectId)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create issue'
    return { ok: false, error: message }
  }
}
