import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, selectInstance, testConnection } from '../plane/client'
import {
  addIssueComment,
  createIssue,
  deleteIssue,
  getIssue,
  issueComments,
  listIssues,
  listCycles,
  listEstimates,
  listLabels,
  listMembers,
  listModules,
  listProjects,
  listStates,
  listWorkItemTypes,
  searchIssues,
  addIssueLink,
  issueAttachments,
  issueLinks,
  updateIssue,
  type PlaneListFilter
} from '../plane/issues'
import type { PlaneIssueUpdate } from '../../shared/plane/types'

const VALID_FILTERS = new Set<PlaneListFilter>(['assigned', 'created', 'all', 'completed', 'open'])
const MIN_LIMIT = 1
const MAX_LIMIT = 50

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requiredString(value: unknown, message: string): string {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new Error(message)
  }
  return normalized
}

function optionalLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(MIN_LIMIT, Math.trunc(value)), MAX_LIMIT)
    : fallback
}

function optionalStringList(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`Invalid ${fieldName}`)
  }
  return value.map((item) => item.trim())
}

function optionalNullableString(value: unknown, fieldName: string): string | null {
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}`)
  }
  return value
}

function optionalEstimatePointValue(value: unknown): string | number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim()
    const numeric = Number(normalized)
    return Number.isFinite(numeric) ? numeric : normalized
  }
  throw new Error('Invalid estimate point value')
}

function nullableEstimatePointValue(value: unknown): string | number | null {
  if (value === null) {
    return null
  }
  const normalized = optionalEstimatePointValue(value)
  if (normalized === undefined) {
    throw new Error('Invalid estimate point value')
  }
  return normalized
}

function normalizeCreateArgs(args: Record<string, unknown>) {
  return {
    projectId: requiredString(args.projectId, 'Plane project ID is required'),
    title: requiredString(args.title, 'Title is required'),
    description: optionalString(args.description),
    stateId: optionalString(args.stateId),
    priority: optionalString(args.priority),
    assigneeIds: optionalStringList(args.assigneeIds, 'assignee IDs'),
    labelIds: optionalStringList(args.labelIds, 'label IDs'),
    cycleId: optionalString(args.cycleId),
    estimatePoint: optionalEstimatePointValue(args.estimatePoint),
    typeId: optionalString(args.typeId),
    moduleId: optionalString(args.moduleId),
    externalSource: optionalString(args.externalSource),
    externalId: optionalString(args.externalId),
    instanceId: optionalString(args.instanceId)
  }
}

function normalizeUpdates(value: unknown): PlaneIssueUpdate {
  if (!value || typeof value !== 'object') {
    throw new Error('Updates object is required')
  }
  const raw = value as Record<string, unknown>
  return {
    ...(raw.title !== undefined ? { title: requiredString(raw.title, 'Title is required') } : {}),
    ...(raw.description !== undefined
      ? { description: optionalNullableString(raw.description, 'description') }
      : {}),
    ...(raw.stateId !== undefined
      ? { stateId: raw.stateId === null ? null : requiredString(raw.stateId, 'Invalid state ID') }
      : {}),
    ...(raw.priority !== undefined
      ? { priority: raw.priority === null ? null : requiredString(raw.priority, 'Invalid priority') }
      : {}),
    ...(raw.cycleId !== undefined
      ? { cycleId: raw.cycleId === null ? null : requiredString(raw.cycleId, 'Invalid cycle ID') }
      : {}),
    ...(raw.estimatePoint !== undefined
      ? {
          estimatePoint:
            raw.estimatePoint === null
              ? null
              : nullableEstimatePointValue(raw.estimatePoint)
        }
      : {}),
    ...(raw.typeId !== undefined
      ? { typeId: raw.typeId === null ? null : requiredString(raw.typeId, 'Invalid type ID') }
      : {}),
    ...(raw.moduleId !== undefined
      ? { moduleId: raw.moduleId === null ? null : requiredString(raw.moduleId, 'Invalid module ID') }
      : {}),
    ...(raw.assigneeIds !== undefined
      ? { assigneeIds: optionalStringList(raw.assigneeIds, 'assignee IDs') }
      : {}),
    ...(raw.labelIds !== undefined ? { labelIds: optionalStringList(raw.labelIds, 'label IDs') } : {})
  }
}

export function registerPlaneHandlers(): void {
  ipcMain.handle('plane:connect', async (_event, args) => connect({ baseUrl: String(args?.baseUrl ?? ''), workspaceSlug: String(args?.workspaceSlug ?? ''), apiKey: String(args?.apiKey ?? '') }))
  ipcMain.handle('plane:disconnect', async (_event, args?: { instanceId?: string }) => disconnect(optionalString(args?.instanceId)))
  ipcMain.handle('plane:selectInstance', async (_event, args: { instanceId: string }) => selectInstance(requiredString(args?.instanceId, 'Plane instance ID is required')))
  ipcMain.handle('plane:status', async () => getStatus())
  ipcMain.handle('plane:testConnection', async (_event, args?: { instanceId?: string }) => testConnection(optionalString(args?.instanceId)))
  ipcMain.handle('plane:listProjects', async (_event, args?: { instanceId?: string }) => listProjects(optionalString(args?.instanceId)))
  ipcMain.handle('plane:listStates', async (_event, args: { projectId: string; instanceId?: string }) => listStates(requiredString(args?.projectId, 'Plane project ID is required'), optionalString(args.instanceId)))
  ipcMain.handle('plane:listLabels', async (_event, args: { projectId: string; instanceId?: string }) => listLabels(requiredString(args?.projectId, 'Plane project ID is required'), optionalString(args.instanceId)))
  ipcMain.handle('plane:listMembers', async (_event, args?: { instanceId?: string }) => listMembers(optionalString(args?.instanceId)))
  ipcMain.handle('plane:listCycles', async (_event, args: { projectId: string; instanceId?: string }) => listCycles(requiredString(args?.projectId, 'Plane project ID is required'), optionalString(args.instanceId)))
  ipcMain.handle('plane:listModules', async (_event, args: { projectId: string; instanceId?: string }) => listModules(requiredString(args?.projectId, 'Plane project ID is required'), optionalString(args.instanceId)))
  ipcMain.handle('plane:listWorkItemTypes', async (_event, args: { projectId: string; instanceId?: string }) => listWorkItemTypes(requiredString(args?.projectId, 'Plane project ID is required'), optionalString(args.instanceId)))
  ipcMain.handle('plane:listEstimates', async (_event, args: { projectId: string; instanceId?: string }) => listEstimates(requiredString(args?.projectId, 'Plane project ID is required'), optionalString(args.instanceId)))
  ipcMain.handle('plane:searchIssues', async (_event, args: { query: string; limit?: number; instanceId?: string }) => searchIssues(requiredString(args?.query, 'Missing query'), optionalLimit(args?.limit, 20), optionalString(args.instanceId)))
  ipcMain.handle('plane:listIssues', async (_event, args?: { filter?: PlaneListFilter; limit?: number; instanceId?: string }) => listIssues(VALID_FILTERS.has(args?.filter as PlaneListFilter) ? args?.filter : undefined, optionalLimit(args?.limit, 30), optionalString(args?.instanceId)))
  ipcMain.handle('plane:getIssue', async (_event, args: { id: string; instanceId?: string }) => getIssue(requiredString(args?.id, 'Plane work item ID is required'), optionalString(args.instanceId)))
  ipcMain.handle('plane:createIssue', async (_event, args) => createIssue(normalizeCreateArgs(args ?? {})))
  ipcMain.handle('plane:updateIssue', async (_event, args: { id: string; updates: PlaneIssueUpdate; instanceId?: string }) => updateIssue(requiredString(args?.id, 'Plane work item ID is required'), normalizeUpdates(args?.updates), optionalString(args.instanceId)))
  ipcMain.handle('plane:deleteIssue', async (_event, args: { id: string; instanceId?: string }) => deleteIssue(requiredString(args?.id, 'Plane work item ID is required'), optionalString(args.instanceId)))
  ipcMain.handle('plane:addIssueComment', async (_event, args: { id: string; body: string; instanceId?: string }) => addIssueComment(requiredString(args?.id, 'Plane work item ID is required'), requiredString(args?.body, 'Comment body is required'), optionalString(args.instanceId)))
  ipcMain.handle('plane:issueComments', async (_event, args: { id: string; instanceId?: string }) => issueComments(requiredString(args?.id, 'Plane work item ID is required'), optionalString(args.instanceId)))
  ipcMain.handle('plane:issueLinks', async (_event, args: { id: string; instanceId?: string }) => issueLinks(requiredString(args?.id, 'Plane work item ID is required'), optionalString(args.instanceId)))
  ipcMain.handle('plane:addIssueLink', async (_event, args: { id: string; title: string; url: string; instanceId?: string }) => addIssueLink(requiredString(args?.id, 'Plane work item ID is required'), requiredString(args?.title, 'Link title is required'), requiredString(args?.url, 'Link URL is required'), optionalString(args.instanceId)))
  ipcMain.handle('plane:issueAttachments', async (_event, args: { id: string; instanceId?: string }) => issueAttachments(requiredString(args?.id, 'Plane work item ID is required'), optionalString(args.instanceId)))
}
