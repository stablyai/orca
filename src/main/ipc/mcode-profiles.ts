import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import { relaunchApp, type AppRelaunchReason } from '../app-relaunch'
import type {
  CreateLocalMCodeProfileArgs,
  CreateLocalMCodeProfileResult,
  CreateCloudLinkedMCodeProfileArgs,
  CreateCloudLinkedMCodeProfileResult,
  FindMCodeProfileProjectsByPathArgs,
  FindMCodeProfileProjectsByPathResult,
  MCodeProfileListResult,
  RefreshCurrentMCodeProfileAuthResult,
  SwitchMCodeProfileArgs,
  SwitchMCodeProfileResult,
  TransferMCodeProfileProjectArgs,
  TransferMCodeProfileProjectResult,
  ConnectCurrentMCodeProfileResult,
  MCodeProfileAuthStatus,
  SelectMCodeProfileOrgArgs,
  SelectMCodeProfileOrgResult,
  SignOutCurrentMCodeProfileResult
} from '../../shared/mcode-profiles'
import {
  createLocalMCodeProfile,
  getMCodeProfileListState,
  seedNewMCodeProfileTelemetryConsent,
  setActiveMCodeProfile
} from '../mcode-profiles/profile-index-store'
import {
  cloudSessionIdentity,
  recordCloudSessionIdentityMutation
} from '../mcode-profiles/profile-cloud-session-mutation'
import { getProfileUserDataPath } from '../mcode-profiles/profile-storage-paths'
import { isMultiProfileUiEnabled } from '../mcode-profiles/profile-ui-scope'
import { transferMCodeProfileProject } from '../mcode-profiles/profile-project-transfer'
import { findMCodeProfileProjectsByPath } from '../mcode-profiles/profile-project-presence'
import { flushActiveProfileBeforeFileMutation } from '../mcode-profiles/profile-persistence-deadline'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import {
  createCloudLinkedMCodeProfile,
  connectCurrentMCodeProfile,
  getCurrentMCodeProfileAuthStatus,
  refreshCurrentMCodeProfileAuth,
  selectCurrentMCodeProfileOrg,
  signOutCurrentMCodeProfile
} from '../mcode-profiles/profile-cloud-service'
import { registerMCodeProfileOrgMemberHandlers } from './mcode-profile-org-members-handlers'

type RegisterMCodeProfileHandlersOptions = {
  onBeforeRelaunch?: () => void | Promise<void>
  onAuthMutation?: () => void
  onBeforeSignOut?: () => void
}

function profileIdFromArgs(args: unknown): string {
  if (
    !args ||
    typeof args !== 'object' ||
    typeof (args as SwitchMCodeProfileArgs).profileId !== 'string'
  ) {
    throw new Error('invalid_mcode_profile_id')
  }
  const profileId = (args as SwitchMCodeProfileArgs).profileId.trim()
  if (!profileId) {
    throw new Error('invalid_mcode_profile_id')
  }
  return profileId
}

function transferProjectArgsFromUnknown(args: unknown): TransferMCodeProfileProjectArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_mcode_profile_project_transfer')
  }
  const candidate = args as TransferMCodeProfileProjectArgs
  const sourceProfileId = candidate.sourceProfileId?.trim()
  const targetProfileId = candidate.targetProfileId?.trim()
  const repoId = candidate.repoId?.trim()
  const mode = candidate.mode
  if (!sourceProfileId || !targetProfileId || !repoId || (mode !== 'move' && mode !== 'copy')) {
    throw new Error('invalid_mcode_profile_project_transfer')
  }
  return {
    sourceProfileId,
    targetProfileId,
    repoId,
    mode
  }
}

function findProjectsByPathArgsFromUnknown(args: unknown): FindMCodeProfileProjectsByPathArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_mcode_profile_project_path')
  }
  const candidate = args as FindMCodeProfileProjectsByPathArgs
  const path = typeof candidate.path === 'string' ? candidate.path.trim() : ''
  if (!path) {
    throw new Error('invalid_mcode_profile_project_path')
  }
  let executionHostId: FindMCodeProfileProjectsByPathArgs['executionHostId'] = null
  if (candidate.executionHostId !== null && candidate.executionHostId !== undefined) {
    if (typeof candidate.executionHostId !== 'string') {
      throw new Error('invalid_mcode_profile_project_path')
    }
    executionHostId = normalizeExecutionHostId(candidate.executionHostId)
    if (!executionHostId) {
      throw new Error('invalid_mcode_profile_project_path')
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
    throw new Error('invalid_mcode_profile_org_selection')
  }
  const orgId = (args as SelectMCodeProfileOrgArgs).orgId?.trim()
  if (!orgId) {
    throw new Error('invalid_mcode_profile_org_selection')
  }
  return orgId
}

function createCloudLinkedProfileArgsFromUnknown(args: unknown): CreateCloudLinkedMCodeProfileArgs {
  if (!args || typeof args !== 'object') {
    return {}
  }
  const candidate = args as CreateCloudLinkedMCodeProfileArgs
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
      '[mcode-profiles] Pre-relaunch cleanup failed; continuing profile switch:',
      error instanceof Error ? error.name : typeof error
    )
  }
}

function scheduleProfileRelaunch(reason: Extract<AppRelaunchReason, `profile-${string}`>): void {
  setTimeout(() => {
    relaunchApp(reason)
    // Why: app.quit() (not app.exit) so before-quit/will-quit still run —
    // renderer scrollback capture, PTY kill, stats flush, and daemon final
    // checkpoints must not be skipped on a profile switch.
    app.quit()
  }, 150)
}

export function registerMCodeProfileHandlers(
  store: Store,
  options: RegisterMCodeProfileHandlersOptions = {}
): void {
  ipcMain.handle(
    'mcodeProfiles:list',
    (): MCodeProfileListResult => ({
      ...getMCodeProfileListState(),
      multiProfileUi: isMultiProfileUiEnabled()
    })
  )

  ipcMain.handle(
    'mcodeProfiles:authStatus',
    (): MCodeProfileAuthStatus => getCurrentMCodeProfileAuthStatus(getProfileUserDataPath())
  )

  ipcMain.handle(
    'mcodeProfiles:createLocal',
    (_event, args?: CreateLocalMCodeProfileArgs): CreateLocalMCodeProfileResult => {
      const result = createLocalMCodeProfile(args)
      seedNewMCodeProfileTelemetryConsent(result.profile.id, store.getSettings().telemetry)
      return result
    }
  )

  ipcMain.handle(
    'mcodeProfiles:switch',
    async (_event, args: SwitchMCodeProfileArgs): Promise<SwitchMCodeProfileResult> => {
      const profileId = profileIdFromArgs(args)
      const current = getMCodeProfileListState()
      if (profileId === current.activeProfileId) {
        return { status: 'already-active' }
      }

      const activeProfile = current.profiles.find(
        (profile) => profile.id === current.activeProfileId
      )
      if (activeProfile?.cloud) {
        // Why: profile selection changes the expected identity synchronously;
        // stale refresh saves must fail even before relaunch teardown finishes.
        recordCloudSessionIdentityMutation(
          cloudSessionIdentity(activeProfile.id, activeProfile.cloud),
          getProfileUserDataPath()
        )
      }
      // Why: the current profile must be persisted before the global index
      // points startup at the target profile.
      await flushActiveProfileBeforeFileMutation(store)
      await runBeforeProfileRelaunch(options.onBeforeRelaunch)
      setActiveMCodeProfile(profileId)

      scheduleProfileRelaunch('profile-switch')

      return { status: 'relaunching' }
    }
  )

  ipcMain.handle(
    'mcodeProfiles:transferProject',
    async (
      _event,
      rawArgs: TransferMCodeProfileProjectArgs
    ): Promise<TransferMCodeProfileProjectResult> => {
      const args = transferProjectArgsFromUnknown(rawArgs)
      const current = getMCodeProfileListState()
      if (args.targetProfileId === current.activeProfileId) {
        throw new Error('active_target_mcode_profile_transfer_requires_relaunch')
      }
      if (args.mode === 'move' && args.sourceProfileId === current.activeProfileId) {
        // Why: transfer before any relaunch side effect so a duplicate-target
        // or validation failure cannot strand the app in a quitting state.
        await flushActiveProfileBeforeFileMutation(store)
        const result = transferMCodeProfileProject(args, getProfileUserDataPath())
        if (result.status === 'transferred') {
          store.freezeWrites()
          await runBeforeProfileRelaunch(options.onBeforeRelaunch)
          setActiveMCodeProfile(args.targetProfileId)
          scheduleProfileRelaunch('profile-transfer')
          return { ...result, willRelaunch: true }
        }
        return result
      }
      await flushActiveProfileBeforeFileMutation(store)
      return transferMCodeProfileProject(args, getProfileUserDataPath())
    }
  )

  ipcMain.handle(
    'mcodeProfiles:findProjectProfiles',
    (_event, rawArgs: FindMCodeProfileProjectsByPathArgs): FindMCodeProfileProjectsByPathResult =>
      findMCodeProfileProjectsByPath(
        findProjectsByPathArgsFromUnknown(rawArgs),
        getProfileUserDataPath()
      )
  )

  ipcMain.handle(
    'mcodeProfiles:connectCurrent',
    async (): Promise<ConnectCurrentMCodeProfileResult> => {
      const result = await connectCurrentMCodeProfile(getProfileUserDataPath())
      if (result.status === 'connected') {
        options.onAuthMutation?.()
      }
      return result
    }
  )

  ipcMain.handle(
    'mcodeProfiles:createCloudLinked',
    async (
      _event,
      rawArgs?: CreateCloudLinkedMCodeProfileArgs
    ): Promise<CreateCloudLinkedMCodeProfileResult> => {
      const result = await createCloudLinkedMCodeProfile(
        getProfileUserDataPath(),
        createCloudLinkedProfileArgsFromUnknown(rawArgs)
      )
      if (result.status === 'created') {
        seedNewMCodeProfileTelemetryConsent(result.profile.id, store.getSettings().telemetry)
        options.onAuthMutation?.()
      }
      return result
    }
  )

  ipcMain.handle(
    'mcodeProfiles:refreshAuth',
    async (): Promise<RefreshCurrentMCodeProfileAuthResult> => {
      const result = await refreshCurrentMCodeProfileAuth(getProfileUserDataPath())
      if (result.status === 'refreshed') {
        options.onAuthMutation?.()
      }
      return result
    }
  )

  ipcMain.handle(
    'mcodeProfiles:signOutCurrent',
    async (): Promise<SignOutCurrentMCodeProfileResult> => {
      options.onBeforeSignOut?.()
      return signOutCurrentMCodeProfile(getProfileUserDataPath())
    }
  )

  ipcMain.handle(
    'mcodeProfiles:selectOrg',
    async (_event, rawArgs: SelectMCodeProfileOrgArgs): Promise<SelectMCodeProfileOrgResult> => {
      const result = await selectCurrentMCodeProfileOrg(
        getProfileUserDataPath(),
        orgIdFromUnknown(rawArgs)
      )
      if (result.status === 'selected') {
        options.onAuthMutation?.()
      }
      return result
    }
  )

  registerMCodeProfileOrgMemberHandlers()
}
