import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
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
  SelectOrcaProfileOrgArgs,
  SelectOrcaProfileOrgResult,
  SignOutCurrentOrcaProfileResult
} from '../../shared/orca-profiles'
import {
  createLocalOrcaProfile,
  getOrcaProfileListState,
  seedNewOrcaProfileTelemetryConsent,
  setActiveOrcaProfile
} from '../orca-profiles/profile-index-store'
import {
  cloudSessionIdentity,
  recordCloudSessionIdentityMutation
} from '../orca-profiles/profile-cloud-session-mutation'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { isMultiProfileUiEnabled } from '../orca-profiles/profile-ui-scope'
import { transferOrcaProfileProject } from '../orca-profiles/profile-project-transfer'
import { findOrcaProfileProjectsByPath } from '../orca-profiles/profile-project-presence'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import {
  createCloudLinkedOrcaProfile,
  connectCurrentOrcaProfile,
  getCurrentOrcaProfileAuthStatus,
  refreshCurrentOrcaProfileAuth,
  selectCurrentOrcaProfileOrg,
  signOutCurrentOrcaProfile
} from '../orca-profiles/profile-cloud-service'
import { registerOrcaProfileOrgMemberHandlers } from './orca-profile-org-members-handlers'

type RegisterOrcaProfileHandlersOptions = {
  onBeforeRelaunch?: () => void | Promise<void>
  onAuthMutation?: () => void
  onBeforeSignOut?: () => void
}

function profileIdFromArgs(args: unknown): string {
  if (
    !args ||
    typeof args !== 'object' ||
    typeof (args as SwitchOrcaProfileArgs).profileId !== 'string'
  ) {
    throw new Error('invalid_orca_profile_id')
  }
  const profileId = (args as SwitchOrcaProfileArgs).profileId.trim()
  if (!profileId) {
    throw new Error('invalid_orca_profile_id')
  }
  return profileId
}

function transferProjectArgsFromUnknown(args: unknown): TransferOrcaProfileProjectArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_orca_profile_project_transfer')
  }
  const candidate = args as TransferOrcaProfileProjectArgs
  const sourceProfileId = candidate.sourceProfileId?.trim()
  const targetProfileId = candidate.targetProfileId?.trim()
  const repoId = candidate.repoId?.trim()
  const mode = candidate.mode
  if (!sourceProfileId || !targetProfileId || !repoId || (mode !== 'move' && mode !== 'copy')) {
    throw new Error('invalid_orca_profile_project_transfer')
  }
  return {
    sourceProfileId,
    targetProfileId,
    repoId,
    mode
  }
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

function scheduleProfileRelaunch(): void {
  setTimeout(() => {
    app.relaunch()
    // Why: app.quit() (not app.exit) so before-quit/will-quit still run —
    // renderer scrollback capture, PTY kill, stats flush, and daemon final
    // checkpoints must not be skipped on a profile switch.
    app.quit()
  }, 150)
}

export function registerOrcaProfileHandlers(
  store: Store,
  options: RegisterOrcaProfileHandlersOptions = {}
): void {
  ipcMain.handle(
    'orcaProfiles:list',
    (): OrcaProfileListResult => ({
      ...getOrcaProfileListState(),
      multiProfileUi: isMultiProfileUiEnabled()
    })
  )

  ipcMain.handle(
    'orcaProfiles:authStatus',
    (): OrcaProfileAuthStatus => getCurrentOrcaProfileAuthStatus(getProfileUserDataPath())
  )

  ipcMain.handle(
    'orcaProfiles:createLocal',
    (_event, args?: CreateLocalOrcaProfileArgs): CreateLocalOrcaProfileResult => {
      const result = createLocalOrcaProfile(args)
      seedNewOrcaProfileTelemetryConsent(result.profile.id, store.getSettings().telemetry)
      return result
    }
  )

  ipcMain.handle(
    'orcaProfiles:switch',
    async (_event, args: SwitchOrcaProfileArgs): Promise<SwitchOrcaProfileResult> => {
      const profileId = profileIdFromArgs(args)
      const current = getOrcaProfileListState()
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
      await runBeforeProfileRelaunch(options.onBeforeRelaunch)
      store.flush()
      setActiveOrcaProfile(profileId)

      scheduleProfileRelaunch()

      return { status: 'relaunching' }
    }
  )

  ipcMain.handle(
    'orcaProfiles:transferProject',
    async (
      _event,
      rawArgs: TransferOrcaProfileProjectArgs
    ): Promise<TransferOrcaProfileProjectResult> => {
      const args = transferProjectArgsFromUnknown(rawArgs)
      const current = getOrcaProfileListState()
      if (args.targetProfileId === current.activeProfileId) {
        throw new Error('active_target_orca_profile_transfer_requires_relaunch')
      }
      if (args.mode === 'move' && args.sourceProfileId === current.activeProfileId) {
        // Why: transfer before any relaunch side effect so a duplicate-target
        // or validation failure cannot strand the app in a quitting state.
        // flush→transfer→freeze runs synchronously with no interleaving, and
        // the freeze keeps late sync saves from resurrecting the moved
        // project from stale memory before the relaunch.
        store.flush()
        const result = transferOrcaProfileProject(args, getProfileUserDataPath())
        if (result.status === 'transferred') {
          store.freezeWrites()
          await runBeforeProfileRelaunch(options.onBeforeRelaunch)
          setActiveOrcaProfile(args.targetProfileId)
          scheduleProfileRelaunch()
          return { ...result, willRelaunch: true }
        }
        return result
      }
      store.flush()
      return transferOrcaProfileProject(args, getProfileUserDataPath())
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

  ipcMain.handle(
    'orcaProfiles:connectCurrent',
    async (): Promise<ConnectCurrentOrcaProfileResult> => {
      const result = await connectCurrentOrcaProfile(getProfileUserDataPath())
      if (result.status === 'connected') {
        options.onAuthMutation?.()
      }
      return result
    }
  )

  ipcMain.handle(
    'orcaProfiles:createCloudLinked',
    async (
      _event,
      rawArgs?: CreateCloudLinkedOrcaProfileArgs
    ): Promise<CreateCloudLinkedOrcaProfileResult> => {
      const result = await createCloudLinkedOrcaProfile(
        getProfileUserDataPath(),
        createCloudLinkedProfileArgsFromUnknown(rawArgs)
      )
      if (result.status === 'created') {
        seedNewOrcaProfileTelemetryConsent(result.profile.id, store.getSettings().telemetry)
        options.onAuthMutation?.()
      }
      return result
    }
  )

  ipcMain.handle(
    'orcaProfiles:refreshAuth',
    async (): Promise<RefreshCurrentOrcaProfileAuthResult> => {
      const result = await refreshCurrentOrcaProfileAuth(getProfileUserDataPath())
      if (result.status === 'refreshed') {
        options.onAuthMutation?.()
      }
      return result
    }
  )

  ipcMain.handle(
    'orcaProfiles:signOutCurrent',
    async (): Promise<SignOutCurrentOrcaProfileResult> => {
      options.onBeforeSignOut?.()
      return signOutCurrentOrcaProfile(getProfileUserDataPath())
    }
  )

  ipcMain.handle(
    'orcaProfiles:selectOrg',
    async (_event, rawArgs: SelectOrcaProfileOrgArgs): Promise<SelectOrcaProfileOrgResult> => {
      const result = await selectCurrentOrcaProfileOrg(
        getProfileUserDataPath(),
        orgIdFromUnknown(rawArgs)
      )
      if (result.status === 'selected') {
        options.onAuthMutation?.()
      }
      return result
    }
  )

  registerOrcaProfileOrgMemberHandlers()
}
