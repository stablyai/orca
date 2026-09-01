import { ipcRenderer } from 'electron'
import type { LinearProjectDetail } from '../../shared/linear/project-types'

export const linearApi = {
  connect: (args: {
    apiKey: string
  }): Promise<{ ok: true; viewer: unknown } | { ok: false; error: string }> =>
    ipcRenderer.invoke('linear:connect', args),

  disconnect: (args?: { workspaceId?: string }): Promise<void> =>
    ipcRenderer.invoke('linear:disconnect', args),

  selectWorkspace: (args: { workspaceId: string }): Promise<unknown> =>
    ipcRenderer.invoke('linear:selectWorkspace', args),

  status: (): Promise<unknown> => ipcRenderer.invoke('linear:status'),

  testConnection: (args?: {
    workspaceId?: string
  }): Promise<{ ok: true; viewer: unknown } | { ok: false; error: string }> =>
    ipcRenderer.invoke('linear:testConnection', args),

  searchIssues: (args: {
    query: string
    limit?: number
    workspaceId?: string
  }): Promise<unknown[]> => ipcRenderer.invoke('linear:searchIssues', args),

  listIssues: (args?: {
    filter?: 'assigned' | 'created' | 'all' | 'completed'
    limit?: number
    workspaceId?: string
    attributeFilter?: unknown
  }): Promise<unknown> => ipcRenderer.invoke('linear:listIssues', args),

  createIssue: (args: {
    teamId: string
    title: string
    description?: string
    workspaceId?: string
    parentIssueId?: string
    projectId?: string | null
    stateId?: string
    priority?: number
    assigneeId?: string | null
    labelIds?: string[]
  }): Promise<
    | { ok: true; id: string; identifier: string; title: string; url: string }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('linear:createIssue', args),

  getIssue: (args: { id: string; workspaceId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('linear:getIssue', args),

  updateIssue: (args: {
    id: string
    updates: unknown
    workspaceId?: string
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('linear:updateIssue', args),

  addIssueComment: (args: {
    issueId: string
    body: string
    workspaceId?: string
  }): Promise<{ ok: true; id: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('linear:addIssueComment', args),

  issueComments: (args: { issueId: string; workspaceId?: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('linear:issueComments', args),

  listTeams: (args?: { workspaceId?: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('linear:listTeams', args),

  listProjects: (args?: {
    query?: string
    limit?: number
    workspaceId?: string
    force?: boolean
  }): Promise<unknown> => ipcRenderer.invoke('linear:listProjects', args),

  createProject: (args: {
    name: string
    description?: string
    content?: string
    teamIds: string[]
    workspaceId?: string
    leadId?: string | null
    memberIds?: string[]
    labelIds?: string[]
    priority?: number
    startDate?: string
    targetDate?: string
  }): Promise<{ ok: true; project: LinearProjectDetail } | { ok: false; error: string }> =>
    ipcRenderer.invoke('linear:createProject', args),

  getProject: (args: { id: string; workspaceId: string; force?: boolean }): Promise<unknown> =>
    ipcRenderer.invoke('linear:getProject', args),

  listProjectIssues: (args: {
    projectId: string
    limit?: number
    workspaceId: string
    force?: boolean
  }): Promise<unknown> => ipcRenderer.invoke('linear:listProjectIssues', args),

  listCustomViews: (args: {
    model: string
    limit?: number
    workspaceId?: string
    force?: boolean
  }): Promise<unknown> => ipcRenderer.invoke('linear:listCustomViews', args),

  getCustomView: (args: {
    viewId: string
    model: string
    workspaceId: string
    force?: boolean
  }): Promise<unknown> => ipcRenderer.invoke('linear:getCustomView', args),

  listCustomViewIssues: (args: {
    viewId: string
    limit?: number
    workspaceId: string
    force?: boolean
  }): Promise<unknown> => ipcRenderer.invoke('linear:listCustomViewIssues', args),

  listCustomViewProjects: (args: {
    viewId: string
    limit?: number
    workspaceId: string
    force?: boolean
  }): Promise<unknown> => ipcRenderer.invoke('linear:listCustomViewProjects', args),

  teamStates: (args: { teamId: string; workspaceId?: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('linear:teamStates', args),

  teamLabels: (args: { teamId: string; workspaceId?: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('linear:teamLabels', args),

  teamMembers: (args: { teamId: string; workspaceId?: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('linear:teamMembers', args)
}
