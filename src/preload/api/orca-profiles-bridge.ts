import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import {
  ORCA_PROFILE_AUTH_STATUS_CHANGED_CHANNEL,
  ORCA_PROFILE_SIGN_IN_PROGRESS_CHANGED_CHANNEL,
  type OrcaCloudSignInEnd,
  type OrcaCloudSignInProgress,
  type OrcaProfileListResult,
  type SwitchOrcaProfileResult,
  type TransferOrcaProfileProjectResult
} from '../../shared/orca-profiles'
import {
  ORCA_BILLING_REFRESH_CHANNEL,
  ORCA_BILLING_RETURN_CHANNEL,
  type OrcaBillingReturn
} from '../../shared/orca-billing'
import {
  ORCA_CLOUD_SETUP_RETURN_CHANNEL,
  type OrcaCloudSetupReturn
} from '../../shared/orca-cloud-setup-link'
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
  onSignInProgressChanged: (
    callback: (progress: OrcaCloudSignInProgress | null, end: OrcaCloudSignInEnd | null) => void
  ): (() => void) => {
    const listener = (
      _event: unknown,
      progress: OrcaCloudSignInProgress | null,
      end?: OrcaCloudSignInEnd | null
    ): void => callback(progress, end ?? null)
    ipcRenderer.on(ORCA_PROFILE_SIGN_IN_PROGRESS_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(ORCA_PROFILE_SIGN_IN_PROGRESS_CHANGED_CHANNEL, listener)
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
  connectCurrent: (args) => ipcRenderer.invoke('orcaProfiles:connectCurrent', args),
  signInProgress: () => ipcRenderer.invoke('orcaProfiles:signInProgress'),
  cancelSignIn: () => ipcRenderer.invoke('orcaProfiles:cancelSignIn'),
  refreshAuth: () => ipcRenderer.invoke('orcaProfiles:refreshAuth'),
  signOutCurrent: () => ipcRenderer.invoke('orcaProfiles:signOutCurrent'),
  selectOrg: (args) => ipcRenderer.invoke('orcaProfiles:selectOrg', args),
  accountMfa: () => ipcRenderer.invoke('orcaProfiles:accountMfa'),
  teamMfaPolicy: (args) => ipcRenderer.invoke('orcaProfiles:teamMfaPolicy', args),
  teamMfaPolicySet: (args) => ipcRenderer.invoke('orcaProfiles:teamMfaPolicySet', args),
  teamMfaPending: (args) => ipcRenderer.invoke('orcaProfiles:teamMfaPending', args),
  teamMfaRemind: (args) => ipcRenderer.invoke('orcaProfiles:teamMfaRemind', args),
  orgMembersList: (args) => ipcRenderer.invoke('orcaProfiles:orgMembersList', args),
  orgMemberInvite: (args) => ipcRenderer.invoke('orcaProfiles:orgMemberInvite', args),
  orgInviteRevoke: (args) => ipcRenderer.invoke('orcaProfiles:orgInviteRevoke', args),
  orgMemberChangeRole: (args) => ipcRenderer.invoke('orcaProfiles:orgMemberChangeRole', args),
  orgMemberRemove: (args) => ipcRenderer.invoke('orcaProfiles:orgMemberRemove', args),
  orgInviteResend: (args) => ipcRenderer.invoke('orcaProfiles:orgInviteResend', args),
  orgLeave: (args) => ipcRenderer.invoke('orcaProfiles:orgLeave', args),
  orgCreate: (args) => ipcRenderer.invoke('orcaProfiles:orgCreate', args),
  orgDeleteCheck: (args) => ipcRenderer.invoke('orcaProfiles:orgDeleteCheck', args),
  orgDelete: (args) => ipcRenderer.invoke('orcaProfiles:orgDelete', args),
  onBillingReturn: (callback: (event: OrcaBillingReturn) => void): (() => void) => {
    const listener = (_event: unknown, payload: OrcaBillingReturn): void => callback(payload)
    ipcRenderer.on(ORCA_BILLING_RETURN_CHANNEL, listener)
    return () => ipcRenderer.removeListener(ORCA_BILLING_RETURN_CHANNEL, listener)
  },
  onBillingRefreshRequested: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(ORCA_BILLING_REFRESH_CHANNEL, listener)
    return () => ipcRenderer.removeListener(ORCA_BILLING_REFRESH_CHANNEL, listener)
  },
  onCloudSetupReturn: (callback: (event: OrcaCloudSetupReturn) => void): (() => void) => {
    const listener = (_event: unknown, payload: OrcaCloudSetupReturn): void => callback(payload)
    ipcRenderer.on(ORCA_CLOUD_SETUP_RETURN_CHANNEL, listener)
    return () => ipcRenderer.removeListener(ORCA_CLOUD_SETUP_RETURN_CHANNEL, listener)
  },
  billingStatus: () => ipcRenderer.invoke('orcaProfiles:billingStatus'),
  billingPlans: () => ipcRenderer.invoke('orcaProfiles:billingPlans'),
  billingOpenCheckout: (args) => ipcRenderer.invoke('orcaProfiles:billingOpenCheckout', args),
  billingOpenPortal: () => ipcRenderer.invoke('orcaProfiles:billingOpenPortal'),
  billingTeamPlans: (args) => ipcRenderer.invoke('orcaProfiles:billingTeamPlans', args),
  billingUsageHistory: (args) => ipcRenderer.invoke('orcaProfiles:billingUsageHistory', args),
  cloudSetupStart: (args) => ipcRenderer.invoke('orcaProfiles:cloudSetupStart', args),
  cloudSetupGet: (args) => ipcRenderer.invoke('orcaProfiles:cloudSetupGet', args),
  cloudSetupLink: (args) => ipcRenderer.invoke('orcaProfiles:cloudSetupLink', args),
  billingSetOverage: (args) => ipcRenderer.invoke('orcaProfiles:billingSetOverage', args),
  billingClaimTrial: () => ipcRenderer.invoke('orcaProfiles:billingClaimTrial')
} satisfies PreloadApi['orcaProfiles']
