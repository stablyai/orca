import { PLANE_WORK_ITEM_KEY_PATTERN } from '../../shared/plane-work-item-url'
import type {
  PlaneComment,
  PlaneLabel,
  PlaneMember,
  PlaneProject,
  PlaneState,
  PlaneWorkItem,
  PlaneWorkItemSearchResult
} from '../../shared/plane-types'
import {
  PlaneApiError,
  buildQuery,
  planeRequest,
  workspacePath,
  type PlaneClientForWorkspace
} from './authenticated-request'
import { PLANE_PAGE_SIZE, listAllPages } from './cursor-pagination'
import { planeHtmlToText } from './description-markdown'
import {
  findProjectByIdentifier,
  listLabels,
  listStates,
  listWorkspaceMembers
} from './project-metadata'
import { mapPlaneMember, mapPlaneWorkItem } from './work-item-mapping'

// Plane returns bare ids for these unless expansion is requested.
const WORK_ITEM_EXPAND = 'state,assignees,labels'
const WORK_ITEM_LIST_MAX = 250
const SEARCH_LIMIT = 20

export type PlaneWorkItemList = {
  items: PlaneWorkItem[]
  /** True when the read stopped at a bound; callers should say so in the UI. */
  truncated: boolean
}

export function parsePlaneWorkItemKey(
  key: string
): { projectIdentifier: string; sequenceId: number } | null {
  const trimmed = key.trim()
  if (!PLANE_WORK_ITEM_KEY_PATTERN.test(trimmed)) {
    return null
  }
  const separator = trimmed.lastIndexOf('-')
  const sequenceId = Number.parseInt(trimmed.slice(separator + 1), 10)
  if (!Number.isSafeInteger(sequenceId) || sequenceId <= 0) {
    return null
  }
  return { projectIdentifier: trimmed.slice(0, separator).toUpperCase(), sequenceId }
}

/**
 * Resolves the human identifier shown in Plane (`PROJ-123`) through the
 * workspace-level endpoint, so no project id is needed up front.
 */
export async function getWorkItemByKey(
  client: PlaneClientForWorkspace,
  key: string,
  knownProject?: PlaneProject
): Promise<PlaneWorkItem | null> {
  const parsed = parsePlaneWorkItemKey(key)
  if (!parsed) {
    return null
  }
  const raw = await planeRequest<unknown>(
    client,
    `${workspacePath(client.workspace, `work-items/${encodeURIComponent(parsed.projectIdentifier)}-${parsed.sequenceId}/`)}${buildQuery(
      { expand: WORK_ITEM_EXPAND }
    )}`
  ).catch((error: unknown) => {
    if (error instanceof PlaneApiError && error.status === 404) {
      return null
    }
    throw error
  })
  if (!raw) {
    return null
  }
  const project = knownProject ?? (await findProjectByIdentifier(client, parsed.projectIdentifier))
  if (!project) {
    return null
  }
  return mapWithFallback(client, project, raw)
}

// A payload can expand `state` yet return bare label/assignee ids, so a null
// result is not a sufficient trigger for the fallback.
function droppedRelationships(raw: unknown, mapped: PlaneWorkItem): boolean {
  const record = (raw ?? {}) as Record<string, unknown>
  const offered = (value: unknown): number => (Array.isArray(value) ? value.length : 0)
  return (
    mapped.labels.length < offered(record.labels) ||
    mapped.assignees.length < offered(record.assignees)
  )
}

/**
 * Maps one read, retrying through the relationship fallback when a deployment
 * ignored `expand` and returned bare ids. Without this a direct read of such a
 * work item resolved to null and looked like "not found".
 */
async function mapWithFallback(
  client: PlaneClientForWorkspace,
  project: PlaneProject,
  raw: unknown
): Promise<PlaneWorkItem | null> {
  const mapped = mapPlaneWorkItem(raw, { workspace: client.workspace, project })
  if (mapped && !droppedRelationships(raw, mapped)) {
    return mapped
  }
  const fallback = await loadRelationshipFallback(client, project)
  return mapPlaneWorkItem(raw, { workspace: client.workspace, project, ...fallback }) ?? mapped
}

/**
 * Deployments that ignore `expand` return bare ids for state, assignees and
 * labels. Loading all three keeps a degraded read complete instead of resolving
 * the state and silently dropping the other two.
 */
async function loadRelationshipFallback(
  client: PlaneClientForWorkspace,
  project: PlaneProject
): Promise<{
  stateById: Map<string, PlaneState>
  labelById: Map<string, PlaneLabel>
  memberById: Map<string, PlaneMember>
}> {
  const [states, labels, members] = await Promise.all([
    listStates(client, project.id),
    listLabels(client, project.id),
    listWorkspaceMembers(client)
  ])
  return {
    stateById: new Map(states.map((state) => [state.id, state])),
    labelById: new Map(labels.map((label) => [label.id, label])),
    memberById: new Map(members.map((member) => [member.id, member]))
  }
}

export async function getWorkItem(
  client: PlaneClientForWorkspace,
  project: PlaneProject,
  workItemId: string
): Promise<PlaneWorkItem | null> {
  const raw = await planeRequest<unknown>(
    client,
    `${workspacePath(client.workspace, `projects/${encodeURIComponent(project.id)}/work-items/${encodeURIComponent(workItemId)}/`)}${buildQuery(
      { expand: WORK_ITEM_EXPAND }
    )}`
  )
  return mapWithFallback(client, project, raw)
}

export async function listWorkItems(
  client: PlaneClientForWorkspace,
  project: PlaneProject,
  options: { orderBy?: string; maxItems?: number } = {}
): Promise<PlaneWorkItemList> {
  const { items, truncated } = await listAllPages<unknown>(
    (cursor) =>
      planeRequest(
        client,
        `${workspacePath(client.workspace, `projects/${encodeURIComponent(project.id)}/work-items/`)}${buildQuery(
          {
            per_page: PLANE_PAGE_SIZE,
            expand: WORK_ITEM_EXPAND,
            order_by: options.orderBy ?? '-updated_at',
            ...(cursor ? { cursor } : {})
          }
        )}`
      ),
    { maxItems: options.maxItems ?? WORK_ITEM_LIST_MAX }
  )
  const context = { workspace: client.workspace, project }
  const mapped = items.map((raw) => mapPlaneWorkItem(raw, context))
  const needsFallback = mapped.some(
    (item, index) => item === null || droppedRelationships(items[index], item)
  )
  if (!needsFallback) {
    return { items: mapped as PlaneWorkItem[], truncated }
  }
  // Re-map against the project's relationships rather than returning a
  // silently short list.
  const fallback = await loadRelationshipFallback(client, project)
  return {
    items: items
      .map((raw) => mapPlaneWorkItem(raw, { ...context, ...fallback }))
      .filter((item): item is PlaneWorkItem => item !== null),
    truncated
  }
}

/** Workspace-wide fuzzy search over work item name, sequence id and project key. */
export async function searchWorkItems(
  client: PlaneClientForWorkspace,
  search: string,
  options: { limit?: number; projectId?: string | null; signal?: AbortSignal } = {}
): Promise<PlaneWorkItemSearchResult[]> {
  const query = search.trim()
  if (!query) {
    return []
  }
  const payload = await planeRequest<{ issues?: unknown }>(
    client,
    `${workspacePath(client.workspace, 'work-items/search/')}${buildQuery({
      search: query,
      limit: options.limit ?? SEARCH_LIMIT,
      // The endpoint only honours project_id when workspace_search is false.
      workspace_search: options.projectId ? 'false' : 'true',
      ...(options.projectId ? { project_id: options.projectId } : {})
    })}`,
    options.signal ? { signal: options.signal } : undefined
  )
  const rows = Array.isArray(payload?.issues) ? payload.issues : []
  return rows
    .map((row) => mapSearchResult(row))
    .filter((row): row is PlaneWorkItemSearchResult => row !== null)
}

export async function listComments(
  client: PlaneClientForWorkspace,
  project: PlaneProject,
  workItemId: string
): Promise<PlaneComment[]> {
  const { items } = await listAllPages<unknown>((cursor) =>
    planeRequest(
      client,
      `${workspacePath(client.workspace, `projects/${encodeURIComponent(project.id)}/work-items/${encodeURIComponent(workItemId)}/comments/`)}${buildQuery(
        // Without expansion the actor is a bare uuid and every comment reads
        // as authorless.
        { per_page: PLANE_PAGE_SIZE, expand: 'actor', ...(cursor ? { cursor } : {}) }
      )}`
    )
  )
  return items
    .map((raw) => mapComment(raw))
    .filter((comment): comment is PlaneComment => comment !== null)
}

function mapComment(raw: unknown): PlaneComment | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : null
  if (!id) {
    return null
  }
  const user = mapPlaneMember(record.actor ?? record.created_by ?? null)
  return {
    id,
    body: planeHtmlToText(typeof record.comment_html === 'string' ? record.comment_html : ''),
    createdAt: typeof record.created_at === 'string' ? record.created_at : '',
    ...(typeof record.updated_at === 'string' ? { updatedAt: record.updated_at } : {}),
    ...(user ? { user } : {})
  }
}

function mapSearchResult(raw: unknown): PlaneWorkItemSearchResult | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : null
  const sequenceId = Number(record.sequence_id)
  const projectIdentifier =
    typeof record.project__identifier === 'string' ? record.project__identifier.toUpperCase() : null
  const projectId = typeof record.project_id === 'string' ? record.project_id : null
  if (
    !id ||
    !projectIdentifier ||
    !projectId ||
    !Number.isSafeInteger(sequenceId) ||
    sequenceId <= 0
  ) {
    return null
  }
  return {
    id,
    key: `${projectIdentifier}-${sequenceId}`,
    sequenceId,
    title: typeof record.name === 'string' ? record.name : '(untitled)',
    projectId,
    projectIdentifier
  }
}
