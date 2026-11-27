import { ipcRenderer } from 'electron'
import type { ItsaplanApi } from './itsaplan-api'

export const itsaplanApi = {
  detectApiUrl: (args) => ipcRenderer.invoke('itsaplan:detectApiUrl', args),
  connect: (args) => ipcRenderer.invoke('itsaplan:connect', args),
  disconnect: () => ipcRenderer.invoke('itsaplan:disconnect'),
  status: () => ipcRenderer.invoke('itsaplan:status'),
  testConnection: () => ipcRenderer.invoke('itsaplan:testConnection'),
  listProjects: (args) => ipcRenderer.invoke('itsaplan:listProjects', args),
  getProjectMetadata: (args) => ipcRenderer.invoke('itsaplan:getProjectMetadata', args),
  listIssues: (args) => ipcRenderer.invoke('itsaplan:listIssues', args),
  getIssue: (args) => ipcRenderer.invoke('itsaplan:getIssue', args),
  createIssue: (args) => ipcRenderer.invoke('itsaplan:createIssue', args),
  updateIssue: (args) => ipcRenderer.invoke('itsaplan:updateIssue', args),
  addComment: (args) => ipcRenderer.invoke('itsaplan:addComment', args)
} satisfies ItsaplanApi
