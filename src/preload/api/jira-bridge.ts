import { ipcRenderer } from 'electron'
import type { JiraProjectStatusOrder } from '../../shared/jira-types'

export const jiraApi = {
  connect: (args: {
    siteUrl: string
    email: string
    apiToken: string
    authType?: 'cloud' | 'server'
  }): Promise<{ ok: true; viewer: unknown } | { ok: false; error: string }> =>
    ipcRenderer.invoke('jira:connect', args),

  disconnect: (args?: { siteId?: string }): Promise<void> =>
    ipcRenderer.invoke('jira:disconnect', args),

  selectSite: (args: { siteId: string }): Promise<unknown> =>
    ipcRenderer.invoke('jira:selectSite', args),

  status: (): Promise<unknown> => ipcRenderer.invoke('jira:status'),

  readStatus: (): Promise<unknown> => ipcRenderer.invoke('jira:readStatus'),

  testConnection: (args?: {
    siteId?: string
  }): Promise<{ ok: true; viewer: unknown } | { ok: false; error: string }> =>
    ipcRenderer.invoke('jira:testConnection', args),

  searchIssues: (args: {
    jql: string
    limit?: number
    siteId?: string
    requestId?: string
  }): Promise<unknown[]> => ipcRenderer.invoke('jira:searchIssues', args),
  cancelSearchIssues: (args: { requestId: string }): Promise<void> =>
    ipcRenderer.invoke('jira:cancelSearchIssues', args),

  listIssues: (args?: {
    filter?: 'assigned' | 'reported' | 'all' | 'done'
    limit?: number
    siteId?: string
  }): Promise<unknown[]> => ipcRenderer.invoke('jira:listIssues', args),

  getIssue: (args: { key: string; siteId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('jira:getIssue', args),

  lookupIssueSummary: (args: {
    key: string
    siteId: string
    requestId?: string
  }): Promise<unknown> => ipcRenderer.invoke('jira:lookupIssueSummary', args),
  cancelIssueSummary: (args: { requestId: string }): Promise<void> =>
    ipcRenderer.invoke('jira:cancelIssueSummary', args),

  createIssue: (args: {
    siteId?: string
    projectId: string
    issueTypeId: string
    title: string
    description?: string
    customFields?: Record<string, unknown>
  }): Promise<{ ok: true; id: string; key: string; url: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('jira:createIssue', args),

  updateIssue: (args: {
    key: string
    updates: unknown
    siteId?: string
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('jira:updateIssue', args),

  addIssueComment: (args: {
    key: string
    body: string
    siteId?: string
  }): Promise<{ ok: true; id: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('jira:addIssueComment', args),

  issueComments: (args: { key: string; siteId?: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('jira:issueComments', args),

  listProjects: (args?: { siteId?: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('jira:listProjects', args),

  listIssueTypes: (args: { projectIdOrKey: string; siteId?: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('jira:listIssueTypes', args),

  listCreateFields: (args: {
    projectIdOrKey: string
    issueTypeId: string
    siteId?: string
  }): Promise<unknown[]> => ipcRenderer.invoke('jira:listCreateFields', args),

  listPriorities: (args?: { siteId?: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('jira:listPriorities', args),

  listAssignableUsers: (args: {
    key: string
    query?: string
    siteId?: string
  }): Promise<unknown[]> => ipcRenderer.invoke('jira:listAssignableUsers', args),
  searchUsers: (args?: { query?: string; siteId?: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('jira:searchUsers', args),

  listTransitions: (args: { key: string; siteId?: string }): Promise<unknown[]> =>
    ipcRenderer.invoke('jira:listTransitions', args),
  getProjectStatusOrder: (args: {
    projectKey: string
    siteId?: string
  }): Promise<JiraProjectStatusOrder> => ipcRenderer.invoke('jira:getProjectStatusOrder', args)
}
