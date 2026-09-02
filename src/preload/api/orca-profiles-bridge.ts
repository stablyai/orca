import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const orcaProfilesApi = {
  list: () => ipcRenderer.invoke('orcaProfiles:list'),
  authStatus: () => ipcRenderer.invoke('orcaProfiles:authStatus'),
  createLocal: (args) => ipcRenderer.invoke('orcaProfiles:createLocal', args),
  createCloudLinked: (args) => ipcRenderer.invoke('orcaProfiles:createCloudLinked', args),
  switchProfile: (args) => ipcRenderer.invoke('orcaProfiles:switch', args),
  transferProject: (args) => ipcRenderer.invoke('orcaProfiles:transferProject', args),
  findProjectProfiles: (args) => ipcRenderer.invoke('orcaProfiles:findProjectProfiles', args),
  connectCurrent: () => ipcRenderer.invoke('orcaProfiles:connectCurrent'),
  refreshAuth: () => ipcRenderer.invoke('orcaProfiles:refreshAuth'),
  signOutCurrent: () => ipcRenderer.invoke('orcaProfiles:signOutCurrent'),
  selectOrg: (args) => ipcRenderer.invoke('orcaProfiles:selectOrg', args),
  orgMembersList: (args) => ipcRenderer.invoke('orcaProfiles:orgMembersList', args),
  orgMemberInvite: (args) => ipcRenderer.invoke('orcaProfiles:orgMemberInvite', args),
  orgInviteRevoke: (args) => ipcRenderer.invoke('orcaProfiles:orgInviteRevoke', args),
  orgMemberChangeRole: (args) => ipcRenderer.invoke('orcaProfiles:orgMemberChangeRole', args),
  orgMemberRemove: (args) => ipcRenderer.invoke('orcaProfiles:orgMemberRemove', args)
} satisfies PreloadApi['orcaProfiles']
