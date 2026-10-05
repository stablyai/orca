import { ipcRenderer } from 'electron'
import type { MantisBTIssue } from '../../shared/mantisbt-types'
import type { PreloadApi } from '../api-types'

export const mantisBTApi = {
  connect: (args: { siteUrl: string; apiToken: string }) =>
    ipcRenderer.invoke('mantisBT:connect', args),

  disconnect: (args?: { siteId?: string }): Promise<void> =>
    ipcRenderer.invoke('mantisBT:disconnect', args),

  selectSite: (args: { siteId: string }) => ipcRenderer.invoke('mantisBT:selectSite', args),

  status: () => ipcRenderer.invoke('mantisBT:status'),

  testConnection: (args?: { siteId?: string }) =>
    ipcRenderer.invoke('mantisBT:testConnection', args),

  listIssues: (args?: {
    filter?: 'assigned' | 'reported' | 'all'
    limit?: number
    siteId?: string
    projectId?: string
    requestId?: string
  }) => ipcRenderer.invoke('mantisBT:listIssues', args),

  onListIssuesProgress: (
    callback: (data: { requestId: string; issues: MantisBTIssue[] }) => void
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { requestId: string; issues: MantisBTIssue[] }
    ): void => callback(data)
    ipcRenderer.on('mantisBT:listIssuesProgress', listener)
    return () => ipcRenderer.removeListener('mantisBT:listIssuesProgress', listener)
  },

  getIssue: (args: { id: string; siteId?: string }) =>
    ipcRenderer.invoke('mantisBT:getIssue', args),

  listProjects: (args?: { siteId?: string }) => ipcRenderer.invoke('mantisBT:listProjects', args)
} satisfies PreloadApi['mantisBT']
