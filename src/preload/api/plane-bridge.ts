import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const planeApi = {
  connect: (args: { baseUrl: string; workspaceSlug: string; apiToken: string; appUrl?: string }) =>
    ipcRenderer.invoke('plane:connect', args),

  disconnect: (args?: { workspaceId?: string }): Promise<{ ok: true }> =>
    ipcRenderer.invoke('plane:disconnect', args),

  status: () => ipcRenderer.invoke('plane:status'),

  selectWorkspace: (args: { workspaceId: string }) =>
    ipcRenderer.invoke('plane:selectWorkspace', args),

  testConnection: (args?: { workspaceId?: string }) =>
    ipcRenderer.invoke('plane:testConnection', args),

  listProjects: (args?: { workspaceId?: string }) => ipcRenderer.invoke('plane:listProjects', args),

  listStates: (args: { projectId: string; workspaceId?: string }) =>
    ipcRenderer.invoke('plane:listStates', args),

  listLabels: (args: { projectId: string; workspaceId?: string }) =>
    ipcRenderer.invoke('plane:listLabels', args),

  listMembers: (args?: { workspaceId?: string }) => ipcRenderer.invoke('plane:listMembers', args),

  listWorkItems: (args: {
    project: unknown
    workspaceId?: string
    orderBy?: string
    limit?: number
  }) => ipcRenderer.invoke('plane:listWorkItems', args),

  getWorkItem: (args: { key: string; workspaceId?: string; project?: unknown }) =>
    ipcRenderer.invoke('plane:getWorkItem', args),

  searchWorkItems: (args: {
    search: string
    limit?: number
    projectId?: string
    workspaceId?: string
    requestId?: string
  }) => ipcRenderer.invoke('plane:searchWorkItems', args),

  cancelSearchWorkItems: (args: { requestId: string }): Promise<void> =>
    ipcRenderer.invoke('plane:cancelSearchWorkItems', args),

  workItemComments: (args: { project: unknown; workItemId: string; workspaceId?: string }) =>
    ipcRenderer.invoke('plane:workItemComments', args),

  updateWorkItem: (args: {
    project: unknown
    workItemId: string
    updates: unknown
    workspaceId?: string
  }) => ipcRenderer.invoke('plane:updateWorkItem', args),

  addComment: (args: {
    project: unknown
    workItemId: string
    body: string
    workspaceId?: string
  }) => ipcRenderer.invoke('plane:addComment', args),

  createWorkItem: (args: { project: unknown; workspaceId?: string }) =>
    ipcRenderer.invoke('plane:createWorkItem', args)
} satisfies PreloadApi['plane']
