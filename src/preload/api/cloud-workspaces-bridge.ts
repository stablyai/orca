import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const cloudWorkspacesApi = {
  available: () => ipcRenderer.invoke('cloudWorkspaces:available'),
  list: (query) => ipcRenderer.invoke('cloudWorkspaces:list', query),
  get: (id) => ipcRenderer.invoke('cloudWorkspaces:get', { id }),
  patch: (id, patch) => ipcRenderer.invoke('cloudWorkspaces:patch', { id, patch }),
  resolveLink: (workspaceId, chatId) =>
    ipcRenderer.invoke('cloudWorkspaces:resolveLink', { workspaceId, chatId }),
  openGrant: (id) => ipcRenderer.invoke('cloudWorkspaces:openGrant', { id }),
  listGrants: (id) => ipcRenderer.invoke('cloudWorkspaces:listGrants', { id }),
  revokeGrant: (id, grantId) => ipcRenderer.invoke('cloudWorkspaces:revokeGrant', { id, grantId }),
  localWorkspaces: () => ipcRenderer.invoke('cloudWorkspaces:localWorkspaces'),
  bindEnvironment: (sandboxId, runtimeEnvironmentId, grantId) =>
    ipcRenderer.invoke('cloudWorkspaces:bindEnvironment', {
      sandboxId,
      runtimeEnvironmentId,
      grantId
    }),
  environmentBindings: () => ipcRenderer.invoke('cloudWorkspaces:environmentBindings'),
  setActive: (args) => ipcRenderer.invoke('cloudWorkspaces:setActive', args),
  getOrgPrompts: () => ipcRenderer.invoke('cloudWorkspaces:getOrgPrompts'),
  putOrgPrompts: (document, revision) =>
    ipcRenderer.invoke('cloudWorkspaces:putOrgPrompts', { document, revision }),
  onOpenLink: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, link: string): void => callback(link)
    ipcRenderer.on('ui:openCloudWorkspaceLink', listener)
    return () => ipcRenderer.removeListener('ui:openCloudWorkspaceLink', listener)
  },
  consumePendingLink: () => ipcRenderer.invoke('ui:consumePendingCloudWorkspaceLink')
} satisfies PreloadApi['cloudWorkspaces']
