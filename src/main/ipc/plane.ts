import { ipcMain } from 'electron'
import {
  connect,
  connectWithOAuth,
  disconnect,
  getStatus,
  selectInstance,
  testConnection
} from '../plane/client'
import {
  createIssue,
  deleteIssue,
  getIssue,
  listIssues,
  searchIssues,
  updateIssue,
  type PlaneListFilter
} from '../plane/issues'
import {
  addIssueComment,
  addIssueLink,
  issueAttachments,
  issueComments,
  issueLinks
} from '../plane/issue-activity'
import {
  listCycles,
  listEstimates,
  listLabels,
  listMembers,
  listModules,
  listProjects,
  listStates,
  listWorkItemTypes
} from '../plane/project-resources'
import type { PlaneIssueUpdate } from '../../shared/plane/types'
import {
  normalizeCreateArgs,
  normalizeFilter,
  normalizeIssueQuery,
  normalizeUpdates,
  optionalLimit,
  optionalString,
  requiredString
} from './plane-normalizers'

export function registerPlaneHandlers(): void {
  ipcMain.handle('plane:connect', async (_event, args) =>
    connect({
      baseUrl: String(args?.baseUrl ?? ''),
      workspaceSlug: String(args?.workspaceSlug ?? ''),
      apiKey: String(args?.apiKey ?? '')
    })
  )
  ipcMain.handle('plane:connectOAuth', async (_event, args) =>
    connectWithOAuth({
      baseUrl: String(args?.baseUrl ?? ''),
      workspaceSlug: String(args?.workspaceSlug ?? ''),
      clientId: String(args?.clientId ?? ''),
      clientSecret: String(args?.clientSecret ?? ''),
      scope: optionalString(args?.scope)
    })
  )
  ipcMain.handle('plane:disconnect', async (_event, args?: { instanceId?: string }) =>
    disconnect(optionalString(args?.instanceId))
  )
  ipcMain.handle('plane:selectInstance', async (_event, args: { instanceId: string }) =>
    selectInstance(requiredString(args?.instanceId, 'Plane instance ID is required'))
  )
  ipcMain.handle('plane:status', async () => getStatus())
  ipcMain.handle('plane:testConnection', async (_event, args?: { instanceId?: string }) =>
    testConnection(optionalString(args?.instanceId))
  )
  ipcMain.handle('plane:listProjects', async (_event, args?: { instanceId?: string }) =>
    listProjects(optionalString(args?.instanceId))
  )
  ipcMain.handle(
    'plane:listStates',
    async (_event, args: { projectId: string; instanceId?: string }) =>
      listStates(
        requiredString(args?.projectId, 'Plane project ID is required'),
        optionalString(args.instanceId)
      )
  )
  ipcMain.handle(
    'plane:listLabels',
    async (_event, args: { projectId: string; instanceId?: string }) =>
      listLabels(
        requiredString(args?.projectId, 'Plane project ID is required'),
        optionalString(args.instanceId)
      )
  )
  ipcMain.handle('plane:listMembers', async (_event, args?: { instanceId?: string }) =>
    listMembers(optionalString(args?.instanceId))
  )
  ipcMain.handle(
    'plane:listCycles',
    async (_event, args: { projectId: string; instanceId?: string }) =>
      listCycles(
        requiredString(args?.projectId, 'Plane project ID is required'),
        optionalString(args.instanceId)
      )
  )
  ipcMain.handle(
    'plane:listModules',
    async (_event, args: { projectId: string; instanceId?: string }) =>
      listModules(
        requiredString(args?.projectId, 'Plane project ID is required'),
        optionalString(args.instanceId)
      )
  )
  ipcMain.handle(
    'plane:listWorkItemTypes',
    async (_event, args: { projectId: string; instanceId?: string }) =>
      listWorkItemTypes(
        requiredString(args?.projectId, 'Plane project ID is required'),
        optionalString(args.instanceId)
      )
  )
  ipcMain.handle(
    'plane:listEstimates',
    async (_event, args: { projectId: string; instanceId?: string }) =>
      listEstimates(
        requiredString(args?.projectId, 'Plane project ID is required'),
        optionalString(args.instanceId)
      )
  )
  ipcMain.handle(
    'plane:searchIssues',
    async (_event, args: { query: string; limit?: number; instanceId?: string }) =>
      searchIssues(
        requiredString(args?.query, 'Missing query'),
        optionalLimit(args?.limit, 20),
        optionalString(args.instanceId)
      )
  )
  ipcMain.handle(
    'plane:listIssues',
    async (
      _event,
      args?: { filter?: PlaneListFilter; query?: unknown; limit?: number; instanceId?: string }
    ) =>
      listIssues(
        normalizeIssueQuery(args?.query) ?? normalizeFilter(args?.filter),
        optionalLimit(args?.limit, 30),
        optionalString(args?.instanceId)
      )
  )
  ipcMain.handle('plane:getIssue', async (_event, args: { id: string; instanceId?: string }) =>
    getIssue(
      requiredString(args?.id, 'Plane work item ID is required'),
      optionalString(args.instanceId)
    )
  )
  ipcMain.handle('plane:createIssue', async (_event, args) =>
    createIssue(normalizeCreateArgs(args ?? {}))
  )
  ipcMain.handle(
    'plane:updateIssue',
    async (_event, args: { id: string; updates: PlaneIssueUpdate; instanceId?: string }) =>
      updateIssue(
        requiredString(args?.id, 'Plane work item ID is required'),
        normalizeUpdates(args?.updates),
        optionalString(args.instanceId)
      )
  )
  ipcMain.handle('plane:deleteIssue', async (_event, args: { id: string; instanceId?: string }) =>
    deleteIssue(
      requiredString(args?.id, 'Plane work item ID is required'),
      optionalString(args.instanceId)
    )
  )
  ipcMain.handle(
    'plane:addIssueComment',
    async (_event, args: { id: string; body: string; instanceId?: string }) =>
      addIssueComment(
        requiredString(args?.id, 'Plane work item ID is required'),
        requiredString(args?.body, 'Comment body is required'),
        optionalString(args.instanceId)
      )
  )
  ipcMain.handle('plane:issueComments', async (_event, args: { id: string; instanceId?: string }) =>
    issueComments(
      requiredString(args?.id, 'Plane work item ID is required'),
      optionalString(args.instanceId)
    )
  )
  ipcMain.handle('plane:issueLinks', async (_event, args: { id: string; instanceId?: string }) =>
    issueLinks(
      requiredString(args?.id, 'Plane work item ID is required'),
      optionalString(args.instanceId)
    )
  )
  ipcMain.handle(
    'plane:addIssueLink',
    async (_event, args: { id: string; title: string; url: string; instanceId?: string }) =>
      addIssueLink(
        requiredString(args?.id, 'Plane work item ID is required'),
        requiredString(args?.title, 'Link title is required'),
        requiredString(args?.url, 'Link URL is required'),
        optionalString(args.instanceId)
      )
  )
  ipcMain.handle(
    'plane:issueAttachments',
    async (_event, args: { id: string; instanceId?: string }) =>
      issueAttachments(
        requiredString(args?.id, 'Plane work item ID is required'),
        optionalString(args.instanceId)
      )
  )
}
