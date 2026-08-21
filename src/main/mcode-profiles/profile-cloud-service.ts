import type {
  ConnectCurrentMCodeProfileResult,
  CreateCloudLinkedMCodeProfileArgs,
  CreateCloudLinkedMCodeProfileResult,
  MCodeProfileAuthStatus,
  SelectMCodeProfileOrgResult,
  SignOutCurrentMCodeProfileResult
} from '../../shared/mcode-profiles'
import { ensureActiveMCodeProfile } from './profile-index-store'
import { getMCodeCloudAuthConfig, isMCodeCloudDevAuthEnabled } from './profile-cloud-auth-config'
import {
  clearMCodeCloudSession,
  readMCodeCloudSession,
  saveMCodeCloudSessionExchange
} from './profile-cloud-session-store'
import { cloudSessionIdentity, tombstoneCloudSession } from './profile-cloud-session-mutation'
import {
  createMCodeCloudProfile,
  exchangeMCodeCloudAuthCode,
  revokeMCodeCloudSession
} from './profile-cloud-client'
import { beginMCodeCloudPkceFlow } from './profile-cloud-pkce'
import {
  createCloudLinkedMCodeProfileRecord,
  linkMCodeProfileToCloud,
  unlinkMCodeProfileFromCloud
} from './profile-cloud-index'
import { runWithFreshMCodeCloudSession } from './profile-cloud-session-refresh'
import {
  connectDevMCodeCloudProfile,
  createDevCloudLinkedMCodeProfile,
  selectDevMCodeCloudOrg
} from './profile-cloud-dev-service'
import { getMCodeProfileAuthStatusFromProfile } from './profile-cloud-auth-status'
import { selectCloudOrgWithMutationFence } from './profile-cloud-org-selection'

export { refreshCurrentMCodeProfileAuth } from './profile-cloud-capability-refresh'

function isUserCancelledAuthError(message: string): boolean {
  return message === 'mcode_cloud_auth_timeout' || message === 'mcode_cloud_auth_denied'
}

function activeAuth(
  active: ReturnType<typeof ensureActiveMCodeProfile>,
  userDataPath: string
): MCodeProfileAuthStatus {
  return getMCodeProfileAuthStatusFromProfile(active, userDataPath)
}

export function getCurrentMCodeProfileAuthStatus(userDataPath: string): MCodeProfileAuthStatus {
  return getMCodeProfileAuthStatusFromProfile(ensureActiveMCodeProfile(userDataPath), userDataPath)
}

export async function connectCurrentMCodeProfile(
  userDataPath: string
): Promise<ConnectCurrentMCodeProfileResult> {
  const active = ensureActiveMCodeProfile(userDataPath)
  if (isMCodeCloudDevAuthEnabled()) {
    const list = connectDevMCodeCloudProfile(active, userDataPath)
    return {
      status: 'connected',
      auth: getCurrentMCodeProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  }

  const configState = getMCodeCloudAuthConfig()
  if (!configState.configured) {
    return {
      status: 'unconfigured',
      auth: activeAuth(active, userDataPath)
    }
  }

  try {
    const code = await beginMCodeCloudPkceFlow(configState.config, active.profile.id)
    const exchange = await exchangeMCodeCloudAuthCode(configState.config, {
      ...code,
      localProfileId: active.profile.id
    })
    saveMCodeCloudSessionExchange(active.profile.id, userDataPath, exchange)
    const list = linkMCodeProfileToCloud(active.profile.id, exchange.cloud, userDataPath)
    return {
      status: 'connected',
      auth: getCurrentMCodeProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isUserCancelledAuthError(message)) {
      return {
        status: 'cancelled',
        auth: getCurrentMCodeProfileAuthStatus(userDataPath)
      }
    }
    return {
      status: 'failed',
      auth: getCurrentMCodeProfileAuthStatus(userDataPath),
      error: message
    }
  }
}

export async function signOutCurrentMCodeProfile(
  userDataPath: string
): Promise<SignOutCurrentMCodeProfileResult> {
  const active = ensureActiveMCodeProfile(userDataPath)
  const configState = getMCodeCloudAuthConfig()
  const session = readMCodeCloudSession(active.profile.id, userDataPath)
  if (active.profile.cloud) {
    // Why: persist the destructive fence before logout network I/O so a
    // refresh already in flight cannot save after explicit sign-out.
    tombstoneCloudSession(
      cloudSessionIdentity(active.profile.id, active.profile.cloud),
      userDataPath
    )
  }
  if (!isMCodeCloudDevAuthEnabled() && configState.configured && session.status === 'found') {
    await revokeMCodeCloudSession(configState.config, session.session).catch(() => undefined)
  }
  clearMCodeCloudSession(active.profile.id, userDataPath)
  const list = unlinkMCodeProfileFromCloud(active.profile.id, userDataPath)
  return {
    status: 'signed-out',
    auth: getCurrentMCodeProfileAuthStatus(userDataPath),
    activeProfileId: list.activeProfileId,
    profiles: list.profiles
  }
}

export async function createCloudLinkedMCodeProfile(
  userDataPath: string,
  args: CreateCloudLinkedMCodeProfileArgs
): Promise<CreateCloudLinkedMCodeProfileResult> {
  const active = ensureActiveMCodeProfile(userDataPath)
  if (isMCodeCloudDevAuthEnabled()) {
    const result = createDevCloudLinkedMCodeProfile(active, userDataPath, args)
    if (result.status !== 'created') {
      return { status: 'reconnect-required', auth: activeAuth(active, userDataPath) }
    }
    return {
      status: 'created',
      auth: getCurrentMCodeProfileAuthStatus(userDataPath),
      activeProfileId: result.list.activeProfileId,
      profiles: result.list.profiles,
      profile: result.list.profile
    }
  }

  const configState = getMCodeCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured', auth: activeAuth(active, userDataPath) }
  }
  try {
    const operation = await runWithFreshMCodeCloudSession(
      configState.config,
      active,
      userDataPath,
      (session) => createMCodeCloudProfile(configState.config, session, args)
    )
    if (operation.status !== 'ok') {
      return { status: 'reconnect-required', auth: activeAuth(active, userDataPath) }
    }
    const created = operation.value
    const list = createCloudLinkedMCodeProfileRecord(
      created.cloud,
      { name: args.name },
      userDataPath
    )
    saveMCodeCloudSessionExchange(list.profile.id, userDataPath, created)
    return {
      status: 'created',
      auth: getCurrentMCodeProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles,
      profile: list.profile
    }
  } catch (error) {
    return {
      status: 'failed',
      auth: getCurrentMCodeProfileAuthStatus(userDataPath),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function selectCurrentMCodeProfileOrg(
  userDataPath: string,
  orgId: string
): Promise<SelectMCodeProfileOrgResult> {
  const active = ensureActiveMCodeProfile(userDataPath)
  if (isMCodeCloudDevAuthEnabled()) {
    const result = selectDevMCodeCloudOrg(active, userDataPath, orgId)
    if (result.status !== 'updated') {
      return { status: 'reconnect-required', auth: activeAuth(active, userDataPath) }
    }
    return {
      status: 'selected',
      auth: getCurrentMCodeProfileAuthStatus(userDataPath),
      activeProfileId: result.list.activeProfileId,
      profiles: result.list.profiles
    }
  }

  const configState = getMCodeCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured', auth: activeAuth(active, userDataPath) }
  }
  try {
    const list = await selectCloudOrgWithMutationFence({
      config: configState.config,
      active,
      userDataPath,
      orgId
    })
    if (!list) {
      return { status: 'reconnect-required', auth: activeAuth(active, userDataPath) }
    }
    return {
      status: 'selected',
      auth: getCurrentMCodeProfileAuthStatus(userDataPath),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  } catch (error) {
    return {
      status: 'failed',
      auth: getCurrentMCodeProfileAuthStatus(userDataPath),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
