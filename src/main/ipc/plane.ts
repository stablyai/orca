import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectWorkspace, testConnection } from '../plane/client'
import {
  planeAddComment,
  planeCreateWorkItem,
  planeGetWorkItem,
  planeListLabels,
  planeListMembers,
  planeListProjects,
  planeListStates,
  planeListWorkItems,
  planeSearchWorkItems,
  planeUpdateWorkItem,
  planeWorkItemComments
} from '../plane/provider-operations'
import { CancellableProviderRequests } from './cancellable-provider-requests'
import { isPlanePriority } from '../../shared/plane-types'
import type {
  PlaneProject,
  PlaneWorkItemUpdate,
  PlaneWorkspaceSelection
} from '../../shared/plane-types'

const searchRequests = new CancellableProviderRequests()

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function clampLimit(value: unknown, fallback: number, max = 100): number {
  const limit = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(Math.max(1, limit), max)
}

function normalizeIdArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
        .map((entry) => entry.trim())
    : []
}

/**
 * The renderer echoes back a project it read from plane:listProjects. Only the
 * identifier and name are taken on trust and they feed display keys and links —
 * never authorization, which remains the stored token's job.
 */
function requireId(value: unknown, label: string, action: string): string {
  const id = normalizeId(value)
  if (!id) {
    throw new Error(`A ${label} is required to ${action}.`)
  }
  return id
}

function requireProject(value: unknown, action: string): PlaneProject {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const id = normalizeId(record.id)
  const identifier = normalizeId(record.identifier)?.toUpperCase()
  if (!id || !identifier) {
    throw new Error(`A project is required to ${action}.`)
  }
  return { id, identifier, name: normalizeId(record.name) ?? identifier }
}

function normalizeWorkItemUpdate(value: unknown): PlaneWorkItemUpdate {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const update: PlaneWorkItemUpdate = {}
  if (typeof record.title === 'string') {
    update.title = record.title
  }
  const stateId = normalizeId(record.stateId)
  if (stateId) {
    update.stateId = stateId
  }
  if (isPlanePriority(record.priority)) {
    update.priority = record.priority
  }
  // null clears the whole set; undefined leaves it untouched.
  if (record.assigneeIds === null || Array.isArray(record.assigneeIds)) {
    update.assigneeIds = record.assigneeIds === null ? null : normalizeIdArray(record.assigneeIds)
  }
  if (record.labelIds === null || Array.isArray(record.labelIds)) {
    update.labelIds = record.labelIds === null ? null : normalizeIdArray(record.labelIds)
  }
  if (record.targetDate === null || typeof record.targetDate === 'string') {
    update.targetDate = record.targetDate
  }
  return update
}

export function registerPlaneHandlers(): void {
  ipcMain.handle('plane:connect', async (_event, args: Record<string, unknown>) =>
    // Normalized like every other channel: connect() trims these before its own
    // try block, so a non-string would surface as a TypeError across IPC rather
    // than the intended "required" message.
    connect({
      baseUrl: readString(args?.baseUrl),
      workspaceSlug: readString(args?.workspaceSlug),
      apiToken: readString(args?.apiToken),
      ...(readString(args?.appUrl) ? { appUrl: readString(args?.appUrl) } : {})
    })
  )

  ipcMain.handle('plane:disconnect', async (_event, args?: { workspaceId?: string }) => {
    disconnect(normalizeId(args?.workspaceId))
    return { ok: true as const }
  })

  ipcMain.handle('plane:status', async () => getStatus())

  ipcMain.handle('plane:selectWorkspace', async (_event, args?: { workspaceId?: string }) =>
    selectWorkspace(
      requireId(
        args?.workspaceId,
        'workspace',
        'select a Plane workspace'
      ) as PlaneWorkspaceSelection
    )
  )

  ipcMain.handle('plane:testConnection', async (_event, args?: { workspaceId?: string }) =>
    testConnection(normalizeId(args?.workspaceId))
  )

  ipcMain.handle('plane:listProjects', async (_event, args?: { workspaceId?: string }) =>
    planeListProjects(normalizeId(args?.workspaceId))
  )

  ipcMain.handle(
    'plane:listStates',
    async (_event, args: { projectId?: string; workspaceId?: string }) =>
      planeListStates(
        requireId(args.projectId, 'project', 'list Plane states'),
        normalizeId(args.workspaceId)
      )
  )

  ipcMain.handle(
    'plane:listLabels',
    async (_event, args: { projectId?: string; workspaceId?: string }) =>
      planeListLabels(
        requireId(args.projectId, 'project', 'list Plane labels'),
        normalizeId(args.workspaceId)
      )
  )

  ipcMain.handle('plane:listMembers', async (_event, args?: { workspaceId?: string }) =>
    planeListMembers(normalizeId(args?.workspaceId))
  )

  ipcMain.handle('plane:listWorkItems', async (_event, args: Record<string, unknown>) =>
    planeListWorkItems({
      project: requireProject(args.project, 'list Plane work items'),
      workspaceId: normalizeId(args.workspaceId),
      ...(normalizeId(args.orderBy) ? { orderBy: normalizeId(args.orderBy) as string } : {}),
      limit: clampLimit(args.limit, 100, 250)
    })
  )

  ipcMain.handle('plane:getWorkItem', async (_event, args: Record<string, unknown>) =>
    planeGetWorkItem({
      key: typeof args.key === 'string' ? args.key : '',
      workspaceId: normalizeId(args.workspaceId),
      ...(args.project ? { project: requireProject(args.project, 'read a Plane work item') } : {})
    })
  )

  ipcMain.handle('plane:searchWorkItems', async (_event, args: Record<string, unknown>) =>
    searchRequests.run(args.requestId, (signal) =>
      planeSearchWorkItems({
        search: typeof args.search === 'string' ? args.search : '',
        limit: clampLimit(args.limit, 20),
        projectId: normalizeId(args.projectId) ?? null,
        workspaceId: normalizeId(args.workspaceId),
        signal
      })
    )
  )

  ipcMain.handle('plane:cancelSearchWorkItems', (_event, args: { requestId?: string }) => {
    searchRequests.cancel(args?.requestId)
  })

  ipcMain.handle('plane:workItemComments', async (_event, args: Record<string, unknown>) =>
    planeWorkItemComments({
      project: requireProject(args.project, 'read Plane comments'),
      workspaceId: normalizeId(args.workspaceId),
      workItemId: requireId(args.workItemId, 'work item id', 'read Plane comments')
    })
  )

  ipcMain.handle('plane:updateWorkItem', async (_event, args: Record<string, unknown>) =>
    planeUpdateWorkItem({
      project: requireProject(args.project, 'update a Plane work item'),
      workspaceId: normalizeId(args.workspaceId),
      workItemId: requireId(args.workItemId, 'work item id', 'update a Plane work item'),
      updates: normalizeWorkItemUpdate(args.updates)
    })
  )

  ipcMain.handle('plane:addComment', async (_event, args: Record<string, unknown>) =>
    planeAddComment({
      project: requireProject(args.project, 'comment on a Plane work item'),
      workspaceId: normalizeId(args.workspaceId),
      workItemId: requireId(args.workItemId, 'work item id', 'comment on a Plane work item'),
      body: typeof args.body === 'string' ? args.body : ''
    })
  )

  ipcMain.handle('plane:createWorkItem', async (_event, args: Record<string, unknown>) => {
    const project = requireProject(args.project, 'create a Plane work item')
    return planeCreateWorkItem({
      project,
      workspaceId: normalizeId(args.workspaceId),
      title: typeof args.title === 'string' ? args.title : '',
      ...(typeof args.description === 'string' ? { description: args.description } : {}),
      ...(normalizeId(args.stateId) ? { stateId: normalizeId(args.stateId) as string } : {}),
      ...(isPlanePriority(args.priority) ? { priority: args.priority } : {}),
      ...(Array.isArray(args.assigneeIds)
        ? { assigneeIds: normalizeIdArray(args.assigneeIds) }
        : {}),
      ...(Array.isArray(args.labelIds) ? { labelIds: normalizeIdArray(args.labelIds) } : {})
    })
  })
}
