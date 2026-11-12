import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const cloudWorkspacesApi = {
  available: () => ipcRenderer.invoke('cloudWorkspaces:available'),
  list: (query) => ipcRenderer.invoke('cloudWorkspaces:list', query),
  get: (id) => ipcRenderer.invoke('cloudWorkspaces:get', { id }),
  patch: (id, patch) => ipcRenderer.invoke('cloudWorkspaces:patch', { id, patch }),
  resolveLink: (target, chatId) =>
    ipcRenderer.invoke('cloudWorkspaces:resolveLink', { target, chatId }),
  openGrant: (id) => ipcRenderer.invoke('cloudWorkspaces:openGrant', { id }),
  readSnapshot: (id) => ipcRenderer.invoke('cloudWorkspaces:readSnapshot', { id }),
  listGrants: (id) => ipcRenderer.invoke('cloudWorkspaces:listGrants', { id }),
  revokeGrant: (id, grantId) => ipcRenderer.invoke('cloudWorkspaces:revokeGrant', { id, grantId }),
  sleep: (id) => ipcRenderer.invoke('cloudWorkspaces:sleep', { id }),
  wake: (id) => ipcRenderer.invoke('cloudWorkspaces:wake', { id }),
  destroy: (id) => ipcRenderer.invoke('cloudWorkspaces:destroy', { id }),
  localWorkspaces: () => ipcRenderer.invoke('cloudWorkspaces:localWorkspaces'),
  noteSent: (id) => ipcRenderer.invoke('cloudWorkspaces:noteSent', { id }),
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
  getPrefs: () => ipcRenderer.invoke('cloudWorkspaces:getPrefs'),
  putPrefs: (document, revision) =>
    ipcRenderer.invoke('cloudWorkspaces:putPrefs', { document, revision }),
  getOrgSlug: (orgName) => ipcRenderer.invoke('cloudWorkspaces:getOrgSlug', { orgName }),
  teammateProfile: (userId, utcOffsetMin) =>
    ipcRenderer.invoke('cloudWorkspaces:teammateProfile', { userId, utcOffsetMin }),
  poke: (userId) => ipcRenderer.invoke('cloudWorkspaces:poke', { userId }),
  pokeInbox: () => ipcRenderer.invoke('cloudWorkspaces:pokeInbox'),
  setPokesEnabled: (enabled) => ipcRenderer.invoke('cloudWorkspaces:setPokesEnabled', { enabled }),
  markPokesSeen: (ids) => ipcRenderer.invoke('cloudWorkspaces:markPokesSeen', { ids }),
  onOpenLink: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, link: string): void => callback(link)
    ipcRenderer.on('ui:openCloudWorkspaceLink', listener)
    return () => ipcRenderer.removeListener('ui:openCloudWorkspaceLink', listener)
  },
  consumePendingLink: () => ipcRenderer.invoke('ui:consumePendingCloudWorkspaceLink')
} satisfies PreloadApi['cloudWorkspaces']
