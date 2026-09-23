import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

type GiteaApi = PreloadApi['gitea']

export const giteaApi = {
  connect: (args) => ipcRenderer.invoke('gitea:connect', args),
  disconnect: (args) => ipcRenderer.invoke('gitea:disconnect', args),
  selectServer: (args) => ipcRenderer.invoke('gitea:selectServer', args),
  status: () => ipcRenderer.invoke('gitea:status'),
  testConnection: (args) => ipcRenderer.invoke('gitea:testConnection', args),
  listWorkItems: (args) => ipcRenderer.invoke('gitea:listWorkItems', args),
  issue: (args) => ipcRenderer.invoke('gitea:issue', args),
  issueComments: (args) => ipcRenderer.invoke('gitea:issueComments', args),
  labels: (args) => ipcRenderer.invoke('gitea:labels', args),
  assignees: (args) => ipcRenderer.invoke('gitea:assignees', args),
  prDetail: (args) => ipcRenderer.invoke('gitea:prDetail', args),
  prFiles: (args) => ipcRenderer.invoke('gitea:prFiles', args),
  prFileContents: (args) => ipcRenderer.invoke('gitea:prFileContents', args),
  prChecks: (args) => ipcRenderer.invoke('gitea:prChecks', args),
  prMerge: (args) => ipcRenderer.invoke('gitea:prMerge', args),
  prReviewComments: (args) => ipcRenderer.invoke('gitea:prReviewComments', args),
  prAddReviewComment: (args) => ipcRenderer.invoke('gitea:prAddReviewComment', args),
  createIssue: (args) => ipcRenderer.invoke('gitea:createIssue', args),
  updateIssue: (args) => ipcRenderer.invoke('gitea:updateIssue', args),
  addIssueComment: (args) => ipcRenderer.invoke('gitea:addIssueComment', args)
} satisfies GiteaApi
