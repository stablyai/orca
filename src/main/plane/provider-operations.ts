import type {
  PlaneComment,
  PlaneCreateWorkItemResult,
  PlaneLabel,
  PlaneMember,
  PlaneMutationResult,
  PlanePriority,
  PlaneProject,
  PlaneState,
  PlaneWorkItem,
  PlaneWorkItemSearchResult,
  PlaneWorkItemUpdate,
  PlaneWorkspaceSelection
} from '../../shared/plane-types'
import { isPlaneAuthError, type PlaneClientForWorkspace } from './authenticated-request'
import { clearToken, getClients, getStatus } from './client'
import { listLabels, listProjects, listStates, listWorkspaceMembers } from './project-metadata'
import { addComment, createWorkItem, updateWorkItem } from './work-item-write'
import {
  getWorkItemByKey,
  listComments,
  listWorkItems,
  searchWorkItems,
  type PlaneWorkItemList
} from './work-items'

/**
 * Argument-shaped operations shared by the IPC handlers and the runtime RPC
 * methods, so client resolution lives in one place instead of being repeated at
 * both transports. Validation stays at the edges.
 */

export type PlaneProjectScope = {
  project: PlaneProject
  workspaceId?: string
}

/**
 * Resolves one workspace to operate on. An 'all' selection (or none) is
 * resolved to the active workspace explicitly: getClients returns the stored
 * array ordered by most-recent-connect, so taking [0] under 'all' would read
 * from a different workspace than getStatus() reports as active.
 */
function requireClient(workspaceId?: string): PlaneClientForWorkspace {
  const explicit = workspaceId && workspaceId !== 'all' ? workspaceId : undefined
  const selection = (explicit ?? getStatus().activeWorkspaceId ?? undefined) as
    | PlaneWorkspaceSelection
    | undefined
  const client = getClients(selection)[0]
  if (!client) {
    throw new Error('Not connected to Plane.')
  }
  return client
}

/**
 * Runs an operation against the resolved workspace and drops the stored
 * credential on a 401. Without this a revoked personal access token leaves the
 * token file in place, so getStatus() keeps reporting connected while every
 * read fails and no reconnect prompt is ever surfaced.
 */
async function withClient<T>(
  workspaceId: string | undefined,
  run: (client: PlaneClientForWorkspace) => Promise<T>
): Promise<T> {
  const client = requireClient(workspaceId)
  try {
    return await run(client)
  } catch (error) {
    if (isPlaneAuthError(error)) {
      clearToken(client.workspace.id)
    }
    throw error
  }
}

export function planeListProjects(workspaceId?: string): Promise<PlaneProject[]> {
  return withClient(workspaceId, (client) => listProjects(client))
}

export function planeListStates(projectId: string, workspaceId?: string): Promise<PlaneState[]> {
  return withClient(workspaceId, (client) => listStates(client, projectId))
}

export function planeListLabels(projectId: string, workspaceId?: string): Promise<PlaneLabel[]> {
  return withClient(workspaceId, (client) => listLabels(client, projectId))
}

export function planeListMembers(workspaceId?: string): Promise<PlaneMember[]> {
  return withClient(workspaceId, (client) => listWorkspaceMembers(client))
}

export function planeListWorkItems(
  args: PlaneProjectScope & { orderBy?: string; limit?: number }
): Promise<PlaneWorkItemList> {
  return withClient(args.workspaceId, (client) =>
    listWorkItems(client, args.project, {
      ...(args.orderBy ? { orderBy: args.orderBy } : {}),
      ...(args.limit === undefined ? {} : { maxItems: args.limit })
    })
  )
}

export function planeGetWorkItem(args: {
  key: string
  workspaceId?: string
  project?: PlaneProject
}): Promise<PlaneWorkItem | null> {
  return withClient(args.workspaceId, (client) => getWorkItemByKey(client, args.key, args.project))
}

export function planeSearchWorkItems(args: {
  search: string
  limit?: number
  projectId?: string | null
  workspaceId?: string
  signal?: AbortSignal
}): Promise<PlaneWorkItemSearchResult[]> {
  return withClient(args.workspaceId, (client) =>
    searchWorkItems(client, args.search, {
      ...(args.limit === undefined ? {} : { limit: args.limit }),
      projectId: args.projectId ?? null,
      ...(args.signal ? { signal: args.signal } : {})
    })
  )
}

export function planeWorkItemComments(
  args: PlaneProjectScope & { workItemId: string }
): Promise<PlaneComment[]> {
  return withClient(args.workspaceId, (client) =>
    listComments(client, args.project, args.workItemId)
  )
}

export function planeUpdateWorkItem(
  args: PlaneProjectScope & { workItemId: string; updates: PlaneWorkItemUpdate }
): Promise<PlaneMutationResult> {
  return withClient(args.workspaceId, (client) =>
    updateWorkItem(client, args.project, args.workItemId, args.updates)
  )
}

export function planeAddComment(
  args: PlaneProjectScope & { workItemId: string; body: string }
): Promise<PlaneMutationResult> {
  return withClient(args.workspaceId, (client) =>
    addComment(client, args.project, args.workItemId, args.body)
  )
}

export function planeCreateWorkItem(
  args: PlaneProjectScope & {
    title: string
    description?: string
    stateId?: string
    priority?: PlanePriority
    assigneeIds?: string[]
    labelIds?: string[]
  }
): Promise<PlaneCreateWorkItemResult> {
  return withClient(args.workspaceId, (client) =>
    createWorkItem(client, args.project, {
      projectId: args.project.id,
      title: args.title,
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.stateId === undefined ? {} : { stateId: args.stateId }),
      ...(args.priority === undefined ? {} : { priority: args.priority }),
      ...(args.assigneeIds === undefined ? {} : { assigneeIds: args.assigneeIds }),
      ...(args.labelIds === undefined ? {} : { labelIds: args.labelIds })
    })
  )
}
