import { ipcRenderer } from 'electron'
import type {
  PlaneConnectArgs,
  PlaneIssueFilter,
  PlaneIssueUpdate
} from '../../shared/plane-types'
import type { PlaneApi } from './plane-api'

export const planeApi: PlaneApi = {
  connect: (args: PlaneConnectArgs) => ipcRenderer.invoke('plane:connect', args),

  disconnect: () => ipcRenderer.invoke('plane:disconnect'),

  status: () => ipcRenderer.invoke('plane:status'),

  testConnection: () => ipcRenderer.invoke('plane:testConnection'),

  selectWorkspace: (args: { workspaceSlug: string }) =>
    ipcRenderer.invoke('plane:selectWorkspace', args),

  listProjects: (args?: { workspaceSlug?: string }) =>
    ipcRenderer.invoke('plane:listProjects', args),

  listStates: (args: { workspaceSlug: string; projectId: string }) =>
    ipcRenderer.invoke('plane:listStates', args),

  listIssues: (args?: {
    workspaceSlug?: string
    projectId?: string
    filter?: PlaneIssueFilter
    limit?: number
  }) => ipcRenderer.invoke('plane:listIssues', args),

  getIssue: (args: { workspaceSlug: string; projectId: string; issueId: string }) =>
    ipcRenderer.invoke('plane:getIssue', args),

  updateIssue: (args: {
    workspaceSlug: string
    projectId: string
    issueId: string
    update: PlaneIssueUpdate
  }) => ipcRenderer.invoke('plane:updateIssue', args),

  getIssueComments: (args: { workspaceSlug: string; projectId: string; issueId: string }) =>
    ipcRenderer.invoke('plane:getIssueComments', args),

  addIssueComment: (args: {
    workspaceSlug: string
    projectId: string
    issueId: string
    comment: string
  }) => ipcRenderer.invoke('plane:addIssueComment', args)
}
