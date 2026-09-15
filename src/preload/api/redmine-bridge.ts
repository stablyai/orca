import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const redmineApi = {
  connect: (args: { siteUrl: string; apiKey: string }) =>
    ipcRenderer.invoke('redmine:connect', args),

  disconnect: (args: { siteId: string }): Promise<void> =>
    ipcRenderer.invoke('redmine:disconnect', args),

  status: () => ipcRenderer.invoke('redmine:status'),

  testConnection: (args: { siteUrl: string; apiKey: string }) =>
    ipcRenderer.invoke('redmine:testConnection', args),

  listIssues: (args?: { filter?: unknown }) => ipcRenderer.invoke('redmine:listIssues', args),

  getIssue: (args: { issueId: number }) => ipcRenderer.invoke('redmine:getIssue', args)
} satisfies PreloadApi['redmine']
