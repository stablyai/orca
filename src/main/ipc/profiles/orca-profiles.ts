import {
  publishToDocuments,
  registerAppHandler,
  type AppWindow,
  appWindowFor
} from '../app-registry/app-handler-registry'

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
import { onOrcaCloudSessionInvalidated } from '../../orca-profiles/cloud-session/profile-cloud-session-invalidation'
import {
  broadcastOrcaProfileAuthStatusChanged,
  broadcastOrcaProfileSignInProgressChanged
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

function scheduleProfileRelaunch(reason: ProfileRelaunchReason, sender: AppWindow): void {
  if (!sender.isDestroyed()) {
    publishToDocuments('app:restart-committed', undefined, { sourceId: sender.id })
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
  registerAppHandler('orcaProfiles:list', (): OrcaProfileListResult => ({
    ...getOrcaProfileListState(),
    multiProfileUi: isMultiProfileUiEnabled()
  }))

  registerAppHandler('orcaProfiles:authStatus', (): OrcaProfileAuthStatus =>
    orcaAccount.getAuthStatus()
  )

  // Push background invalidation; re-entering onAuthMutation would loop into the relay coordinator that just failed.
  onOrcaCloudSessionInvalidated(broadcastOrcaProfileAuthStatusChanged)
  onOrcaCloudSignInProgressChanged(broadcastOrcaProfileSignInProgressChanged)

  registerAppHandler(
    'orcaProfiles:createLocal',
    (_event, args?: CreateLocalOrcaProfileArgs): CreateLocalOrcaProfileResult => {
      const result = createLocalOrcaProfile(args)
      initializeNewOrcaProfileState(result.profile.id, store.getSettings().telemetry)
      return result
    }
  )

  registerAppHandler(
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

      scheduleProfileRelaunch('profile-switch', appWindowFor(event))

      return { status: 'relaunching' }
    }
  )

  registerAppHandler(
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
            scheduleProfileRelaunch('profile-transfer', appWindowFor(event))
          }
        )
        if (result.status === 'transferred') {
          await runBeforeProfileRelaunch(options.onBeforeRelaunch)
          try {
            setActiveOrcaProfile(args.targetProfileId)
          } finally {
            // The source has already changed and its writer cannot resume.
            scheduleProfileRelaunch('profile-transfer', appWindowFor(event))
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

  registerAppHandler(
    'orcaProfiles:findProjectProfiles',
    (_event, rawArgs: FindOrcaProfileProjectsByPathArgs): FindOrcaProfileProjectsByPathResult =>
      findOrcaProfileProjectsByPath(
        findProjectsByPathArgsFromUnknown(rawArgs),
        getProfileUserDataPath()
      )
  )

  registerAppHandler('orcaProfiles:connectCurrent', (): Promise<ConnectCurrentOrcaProfileResult> =>
    orcaAccount.connect()
  )

  registerAppHandler('orcaProfiles:signInProgress', (): OrcaCloudSignInProgress | null =>
    getOrcaCloudSignInProgress()
  )

  registerAppHandler('orcaProfiles:cancelSignIn', (): void => cancelOrcaCloudSignIn())

  registerAppHandler(
    'orcaProfiles:createCloudLinked',
    async (
      _event,
      rawArgs?: CreateCloudLinkedOrcaProfileArgs
    ): Promise<CreateCloudLinkedOrcaProfileResult> =>
      orcaAccount.createCloudLinked(createCloudLinkedProfileArgsFromUnknown(rawArgs), (profileId) =>
        initializeNewOrcaProfileState(profileId, store.getSettings().telemetry)
      )
  )

  registerAppHandler('orcaProfiles:refreshAuth', (): Promise<RefreshCurrentOrcaProfileAuthResult> =>
    orcaAccount.refreshAuth()
  )

  registerAppHandler('orcaProfiles:signOutCurrent', (): Promise<SignOutCurrentOrcaProfileResult> =>
    orcaAccount.signOut()
  )

  registerAppHandler(
    'orcaProfiles:selectOrg',
    async (_event, rawArgs: SelectOrcaProfileOrgArgs): Promise<SelectOrcaProfileOrgResult> =>
      orcaAccount.selectOrg(orgIdFromUnknown(rawArgs))
  )

  registerOrcaProfileOrgMemberHandlers()
}
