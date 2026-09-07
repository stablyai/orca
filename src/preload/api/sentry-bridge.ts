import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const sentryApi = {
  connect: (args) => ipcRenderer.invoke('sentry:connect', args),
  disconnect: () => ipcRenderer.invoke('sentry:disconnect'),
  selectOrganization: (args) => ipcRenderer.invoke('sentry:selectOrganization', args),
  status: () => ipcRenderer.invoke('sentry:status'),
  testConnection: () => ipcRenderer.invoke('sentry:testConnection'),
  listProjects: () => ipcRenderer.invoke('sentry:listProjects'),
  listEnvironments: () => ipcRenderer.invoke('sentry:listEnvironments'),
  listAssignees: () => ipcRenderer.invoke('sentry:listAssignees'),
  listIssues: (args) => ipcRenderer.invoke('sentry:listIssues', args),
  getIssue: (args) => ipcRenderer.invoke('sentry:getIssue', args),
  listEvents: (args) => ipcRenderer.invoke('sentry:listEvents', args),
  updateIssue: (args) => ipcRenderer.invoke('sentry:updateIssue', args)
} satisfies PreloadApi['sentry']
