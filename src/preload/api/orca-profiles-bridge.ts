import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import {
  ORCA_PROFILE_AUTH_STATUS_CHANGED_CHANNEL,
  type OrcaProfileListResult,
  type SwitchOrcaProfileResult,
  type TransferOrcaProfileProjectResult
} from '../../shared/orca-profiles'
import { prepareAndInvokeAppRestart } from '../renderer-restart-wiring'
import { awaitBeforeUnloadCheckpoint } from '../preload-runtime-support'

export const orcaProfilesApi = {
  list: () => ipcRenderer.invoke('orcaProfiles:list'),
  authStatus: () => ipcRenderer.invoke('orcaProfiles:authStatus'),
  onAuthStatusChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(ORCA_PROFILE_AUTH_STATUS_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(ORCA_PROFILE_AUTH_STATUS_CHANGED_CHANNEL, listener)
  },
  createLocal: (args) => ipcRenderer.invoke('orcaProfiles:createLocal', args),
  createCloudLinked: (args) => ipcRenderer.invoke('orcaProfiles:createCloudLinked', args),
  switchProfile: (args) =>
    prepareAndInvokeAppRestart(
      window,
      (): Promise<SwitchOrcaProfileResult> => ipcRenderer.invoke('orcaProfiles:switch', args),
      awaitBeforeUnloadCheckpoint,
      (result) => result.status === 'relaunching'
    ),
  transferProject: async (args) => {
    const invoke = (): Promise<TransferOrcaProfileProjectResult> =>
      ipcRenderer.invoke('orcaProfiles:transferProject', args)
    if (args.mode !== 'move') {
      return invoke()
    }
    const current: OrcaProfileListResult = await ipcRenderer.invoke('orcaProfiles:list')
    if (args.sourceProfileId !== current.activeProfileId) {
      return invoke()
    }
    return prepareAndInvokeAppRestart(
      window,
      invoke,
      awaitBeforeUnloadCheckpoint,
      (result) => result.status === 'transferred' && result.willRelaunch === true
    )
  },
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
