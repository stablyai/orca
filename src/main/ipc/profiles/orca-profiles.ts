import { registerCloudServerHandlers } from './cloud-server-handlers'
import { ipcMain, type WebContents } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import { relaunchApp, type AppRelaunchReason } from '../../startup/quit/app-relaunch'
import { quitProcess } from '../../startup/quit/process-quit-request'
import type {
  CreateLocalOrcaProfileArgs,
  CreateLocalOrcaProfileResult,
  CreateCloudLinkedOrcaProfileArgs,
  CreateCloudLinkedOrcaProfileResult,
  FindOrcaProfileProjectsByPathArgs,
  FindOrcaProfileProjectsByPathResult,
  OrcaProfileListResult,
  RefreshCurrentOrcaProfileAuthResult,
  SwitchOrcaProfileArgs,
  SwitchOrcaProfileResult,
  TransferOrcaProfileProjectArgs,
  TransferOrcaProfileProjectResult,
  ConnectCurrentOrcaProfileResult,
  OrcaProfileAuthStatus,
  OrcaCloudSignInProgress,
  SelectOrcaProfileOrgArgs,
  SelectOrcaProfileOrgResult,
  SignOutCurrentOrcaProfileResult
} from '../../../shared/orca-profiles/orca-profiles'
import {
  createLocalOrcaProfile,
  getOrcaProfileListState,
  setActiveOrcaProfile
} from '../../orca-profiles/profile-index-store'
import { initializeNewOrcaProfileState } from '../../orca-profiles/storage/new-profile-state'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { isMultiProfileUiEnabled } from '../../orca-profiles/profile-ui-scope'
import { transferOrcaProfileProject } from '../../orca-profiles/project-transfer/profile-project-transfer'
import { transferActiveProfileProject } from '../../orca-profiles/project-transfer/profile-active-transfer'
import { findOrcaProfileProjectsByPath } from '../../orca-profiles/catalog/profile-project-presence'
import {
  flushActiveProfileBeforeFileMutation,
  flushActiveProfileBeforeRelaunch
} from '../../orca-profiles/storage/profile-persistence-deadline'
import { normalizeExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { OrcaAccountService } from '../../orca-profiles/orca-account-service'
import { registerOrcaProfileOrgMemberHandlers } from './orca-profile-org-members-handlers'
import {
  isOrcaCloudConsoleSection,
  type OrcaCloudConsoleOpenResult
} from '../../../shared/orca-cloud-console'
import { onOrcaCloudSessionInvalidated } from '../../orca-profiles/cloud-session/profile-cloud-session-invalidation'
import {
  broadcastOrcaProfileAuthStatusChanged,
  broadcastOrcaProfileSignInProgressChanged,
  broadcastTeamPolicyChanges
} from './orca-profile-auth-status-broadcast'
import {
  cancelOrcaCloudSignIn,
  getOrcaCloudSignInProgress,
  onOrcaCloudSignInProgressChanged
} from '../../orca-profiles/cloud-auth/profile-cloud-sign-in-progress'
import { profileIdFromArgs } from './orca-profile-id-arg'
import { transferProjectArgsFromUnknown } from './orca-profile-project-transfer-args'

type RegisterOrcaProfileHandlersOptions = {
  onBeforeRelaunch?: () => void | Promise<void>
}

function findProjectsByPathArgsFromUnknown(args: unknown): FindOrcaProfileProjectsByPathArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_orca_profile_project_path')
  }
  const candidate = args as FindOrcaProfileProjectsByPathArgs
  const path = typeof candidate.path === 'string' ? candidate.path.trim() : ''
  if (!path) {
    throw new Error('invalid_orca_profile_project_path')
  }
  let executionHostId: FindOrcaProfileProjectsByPathArgs['executionHostId'] = null
  if (candidate.executionHostId !== null && candidate.executionHostId !== undefined) {
    if (typeof candidate.executionHostId !== 'string') {
      throw new Error('invalid_orca_profile_project_path')
    }
    executionHostId = normalizeExecutionHostId(candidate.executionHostId)
    if (!executionHostId) {
      throw new Error('invalid_orca_profile_project_path')
    }
  }
  return {
    path,
    connectionId:
      typeof candidate.connectionId === 'string' ? candidate.connectionId.trim() || null : null,
    executionHostId,
    excludeProfileId:
      typeof candidate.excludeProfileId === 'string'
        ? candidate.excludeProfileId.trim() || null
        : null
  }
}

function orgIdFromUnknown(args: unknown): string {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_orca_profile_org_selection')
  }
  const orgId = (args as SelectOrcaProfileOrgArgs).orgId?.trim()
  if (!orgId) {
    throw new Error('invalid_orca_profile_org_selection')
  }
  return orgId
}

function createCloudLinkedProfileArgsFromUnknown(args: unknown): CreateCloudLinkedOrcaProfileArgs {
  if (!args || typeof args !== 'object') {
    return {}
  }
  const candidate = args as CreateCloudLinkedOrcaProfileArgs
  const orgId = typeof candidate.orgId === 'string' ? candidate.orgId.trim() : undefined
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : undefined
  return {
    ...(orgId ? { orgId } : {}),
    ...(name ? { name } : {})
  }
}

async function runBeforeProfileRelaunch(
  onBeforeRelaunch?: () => void | Promise<void>
): Promise<void> {
  try {
    await onBeforeRelaunch?.()
  } catch (error) {
    console.warn(
      '[orca-profiles] Pre-relaunch cleanup failed; continuing profile switch:',
      error instanceof Error ? error.name : typeof error
    )
  }
}

type ProfileRelaunchReason = Extract<AppRelaunchReason, `profile-${string}`>

function scheduleProfileRelaunch(reason: ProfileRelaunchReason, sender: WebContents): void {
  if (!sender.isDestroyed()) {
    sender.send('app:restart-committed')
  }
  setTimeout(() => {
    relaunchApp(reason)
    // Normal quit preserves renderer scrollback, PTY teardown, stats flush and final daemon checkpoints.
    quitProcess()
  }, 150)
}

export function registerOrcaProfileHandlers(
  store: Store,
  orcaAccount: OrcaAccountService,
  options: RegisterOrcaProfileHandlersOptions = {}
): void {
  registerCloudServerHandlers(store, orcaAccount)
  ipcMain.handle('orcaProfiles:list', (): OrcaProfileListResult => ({
    ...getOrcaProfileListState(),
    multiProfileUi: isMultiProfileUiEnabled()
  }))

  ipcMain.handle('orcaProfiles:authStatus', (): OrcaProfileAuthStatus =>
    orcaAccount.getAuthStatus()
  )

  // Push background invalidation; re-entering onAuthMutation would loop into the relay coordinator that just failed.
  onOrcaCloudSessionInvalidated(broadcastOrcaProfileAuthStatusChanged)
  broadcastTeamPolicyChanges()
  onOrcaCloudSignInProgressChanged(broadcastOrcaProfileSignInProgressChanged)

  ipcMain.handle(
    'orcaProfiles:createLocal',
    (_event, args?: CreateLocalOrcaProfileArgs): CreateLocalOrcaProfileResult => {
      const result = createLocalOrcaProfile(args)
      initializeNewOrcaProfileState(result.profile.id, store.getSettings().telemetry)
      return result
    }
  )

  ipcMain.handle(
    'orcaProfiles:switch',
    async (event, args: SwitchOrcaProfileArgs): Promise<SwitchOrcaProfileResult> => {
      const profileId = profileIdFromArgs(args)
      const current = getOrcaProfileListState()
      if (profileId === current.activeProfileId) {
        return { status: 'already-active' }
      }

      // Flush the source profile before switching the startup index; keep its writer alive through relaunch cleanup.
      await flushActiveProfileBeforeRelaunch(store)
      setActiveOrcaProfile(profileId)
      await runBeforeProfileRelaunch(options.onBeforeRelaunch)

      scheduleProfileRelaunch('profile-switch', event.sender)

      return { status: 'relaunching' }
    }
  )

  ipcMain.handle(
    'orcaProfiles:transferProject',
    async (
      event,
      rawArgs: TransferOrcaProfileProjectArgs
    ): Promise<TransferOrcaProfileProjectResult> => {
      const args = transferProjectArgsFromUnknown(rawArgs)
      const current = getOrcaProfileListState()
      if (args.targetProfileId === current.activeProfileId) {
        throw new Error('active_target_orca_profile_transfer_requires_relaunch')
      }
      if (args.mode === 'move' && args.sourceProfileId === current.activeProfileId) {
        // Finish transfer before relaunch side effects so validation failure cannot strand the app quitting.
        const result = await transferActiveProfileProject(
          args,
          getProfileUserDataPath(),
          store,
          async () => {
            await runBeforeProfileRelaunch(options.onBeforeRelaunch)
            scheduleProfileRelaunch('profile-transfer', event.sender)
          }
        )
        if (result.status === 'transferred') {
          await runBeforeProfileRelaunch(options.onBeforeRelaunch)
          try {
            setActiveOrcaProfile(args.targetProfileId)
          } finally {
            // The source has already changed and its writer cannot resume.
            scheduleProfileRelaunch('profile-transfer', event.sender)
          }
          return { ...result, willRelaunch: true }
        }
        return result
      }
      if (args.sourceProfileId !== current.activeProfileId) {
        await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
        return transferOrcaProfileProject(args, getProfileUserDataPath())
      }
      const maintenance = await flushActiveProfileBeforeFileMutation(store)
      try {
        return transferOrcaProfileProject(args, getProfileUserDataPath())
      } finally {
        await maintenance.resume()
      }
    }
  )

  ipcMain.handle(
    'orcaProfiles:findProjectProfiles',
    (_event, rawArgs: FindOrcaProfileProjectsByPathArgs): FindOrcaProfileProjectsByPathResult =>
      findOrcaProfileProjectsByPath(
        findProjectsByPathArgsFromUnknown(rawArgs),
        getProfileUserDataPath()
      )
  )

  ipcMain.handle('orcaProfiles:connectCurrent', (): Promise<ConnectCurrentOrcaProfileResult> =>
    orcaAccount.connect()
  )

  ipcMain.handle('orcaProfiles:signInProgress', (): OrcaCloudSignInProgress | null =>
    getOrcaCloudSignInProgress()
  )

  ipcMain.handle('orcaProfiles:cancelSignIn', (): void => cancelOrcaCloudSignIn())

  ipcMain.handle(
    'orcaProfiles:createCloudLinked',
    async (
      _event,
      rawArgs?: CreateCloudLinkedOrcaProfileArgs
    ): Promise<CreateCloudLinkedOrcaProfileResult> =>
      orcaAccount.createCloudLinked(createCloudLinkedProfileArgsFromUnknown(rawArgs), (profileId) =>
        initializeNewOrcaProfileState(profileId, store.getSettings().telemetry)
      )
  )

  ipcMain.handle('orcaProfiles:refreshAuth', (): Promise<RefreshCurrentOrcaProfileAuthResult> =>
    orcaAccount.refreshAuth()
  )

  ipcMain.handle('orcaProfiles:signOutCurrent', (): Promise<SignOutCurrentOrcaProfileResult> =>
    orcaAccount.signOut()
  )

  ipcMain.handle(
    'orcaProfiles:selectOrg',
    async (_event, rawArgs: SelectOrcaProfileOrgArgs): Promise<SelectOrcaProfileOrgResult> =>
      orcaAccount.selectOrg(orgIdFromUnknown(rawArgs))
  )

  ipcMain.handle(
    'orcaProfiles:openCloudConsole',
    async (_event, rawArgs: unknown): Promise<OrcaCloudConsoleOpenResult> => {
      const section =
        typeof rawArgs === 'object' && rawArgs !== null && 'section' in rawArgs
          ? rawArgs.section
          : undefined
      if (!isOrcaCloudConsoleSection(section)) {
        return { status: 'failed', error: 'invalid_orca_cloud_console_section' }
      }
      return orcaAccount.openConsole(section)
    }
  )

  registerOrcaProfileOrgMemberHandlers()
}
