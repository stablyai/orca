import { ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type {
  OrcaCloudSignInProgress,
  OrcaProfileAuthStatus,
  OrcaProfileListResult
} from '../../../shared/orca-profiles/orca-profiles'
import { getOrcaProfileListState } from '../../orca-profiles/profile-index-store'
import { isMultiProfileUiEnabled } from '../../orca-profiles/profile-ui-scope'
import type { OrcaAccountService } from '../../orca-profiles/orca-account-service'
import { onOrcaCloudSessionInvalidated } from '../../orca-profiles/cloud-session/profile-cloud-session-invalidation'
import {
  broadcastOrcaProfileAuthStatusChanged,
  broadcastOrcaProfileSignInProgressChanged,
  broadcastTeamPolicyChanges
} from './orca-profile-auth-status-broadcast'
import {
  getOrcaCloudSignInProgress,
  onOrcaCloudSignInProgressChanged
} from '../../orca-profiles/cloud-auth/profile-cloud-sign-in-progress'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import type { RegisterOrcaProfileHandlersOptions } from './orca-profile-action-handlers'

const ORCA_PROFILE_ACTION_IPC_CHANNELS = [
  'orcaProfiles:createLocal',
  'orcaProfiles:switch',
  'orcaProfiles:transferProject',
  'orcaProfiles:findProjectProfiles',
  'orcaProfiles:connectCurrent',
  'orcaProfiles:cancelSignIn',
  'orcaProfiles:createCloudLinked',
  'orcaProfiles:refreshAuth',
  'orcaProfiles:signOutCurrent',
  'orcaProfiles:selectOrg',
  'orcaProfiles:openCloudConsole'
] as const

const ORCA_PROFILE_ORG_MEMBER_IPC_CHANNELS = [
  'orcaProfiles:orgMembersList',
  'orcaProfiles:orgMemberInvite',
  'orcaProfiles:orgInviteRevoke',
  'orcaProfiles:orgMemberChangeRole',
  'orcaProfiles:orgMemberRemove'
] as const

export function registerOrcaProfileHandlers(
  store: Store,
  orcaAccount: OrcaAccountService,
  options: RegisterOrcaProfileHandlersOptions = {}
): void {
  ipcMain.handle('orcaProfiles:list', (): OrcaProfileListResult => ({
    ...getOrcaProfileListState(),
    multiProfileUi: isMultiProfileUiEnabled()
  }))

  ipcMain.handle('orcaProfiles:authStatus', (): OrcaProfileAuthStatus =>
    orcaAccount.getAuthStatus()
  )

  ipcMain.handle('orcaProfiles:signInProgress', (): OrcaCloudSignInProgress | null =>
    getOrcaCloudSignInProgress()
  )

  // Push background invalidation; re-entering onAuthMutation would loop into the relay coordinator that just failed.
  onOrcaCloudSessionInvalidated(broadcastOrcaProfileAuthStatusChanged)
  broadcastTeamPolicyChanges()
  onOrcaCloudSignInProgressChanged(broadcastOrcaProfileSignInProgressChanged)

  registerLazyIpcHandleGroup(ORCA_PROFILE_ACTION_IPC_CHANNELS, async (ipc) => {
    const { registerOrcaProfileActionHandlers } = await import('./orca-profile-action-handlers')
    registerOrcaProfileActionHandlers(store, orcaAccount, options, ipc)
  })

  registerLazyIpcHandleGroup(ORCA_PROFILE_ORG_MEMBER_IPC_CHANNELS, async (ipc) => {
    const { registerOrcaProfileOrgMemberHandlers } =
      await import('./orca-profile-org-members-handlers')
    registerOrcaProfileOrgMemberHandlers(ipc)
  })
}
