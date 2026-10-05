import { ipcRenderer } from 'electron'
import type { YouTrackApi } from './youtrack-api'

export const youtrackApi: YouTrackApi = {
  status: () => ipcRenderer.invoke('youtrack:status'),
  connect: (args) => ipcRenderer.invoke('youtrack:connect', args),
  disconnect: () => ipcRenderer.invoke('youtrack:disconnect'),
  testConnection: () => ipcRenderer.invoke('youtrack:testConnection'),
  listIssues: (args) => ipcRenderer.invoke('youtrack:listIssues', args),
  getIssue: (args) => ipcRenderer.invoke('youtrack:getIssue', args),
  getComments: (args) => ipcRenderer.invoke('youtrack:getComments', args),
  addComment: (args) => ipcRenderer.invoke('youtrack:addComment', args),
  getStateOptions: (args) => ipcRenderer.invoke('youtrack:getStateOptions', args),
  setState: (args) => ipcRenderer.invoke('youtrack:setState', args),
  listProjects: (args) => ipcRenderer.invoke('youtrack:listProjects', args),
  getProjectFields: (args) => ipcRenderer.invoke('youtrack:getProjectFields', args),
  updateField: (args) => ipcRenderer.invoke('youtrack:updateField', args),
  createIssue: (args) => ipcRenderer.invoke('youtrack:createIssue', args)
}
