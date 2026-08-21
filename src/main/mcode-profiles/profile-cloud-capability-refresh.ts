import type { RefreshCurrentMCodeProfileAuthResult } from '../../shared/mcode-profiles'
import { getMCodeCloudAuthConfig, isMCodeCloudDevAuthEnabled } from './profile-cloud-auth-config'
import { getMCodeProfileAuthStatusFromProfile } from './profile-cloud-auth-status'
import { refreshMCodeCloudCapabilities } from './profile-cloud-client'
import { linkMCodeProfileToCloud } from './profile-cloud-index'
import { ensureActiveMCodeProfile, getMCodeProfileListState } from './profile-index-store'
import { refreshDevMCodeCloudProfile } from './profile-cloud-dev-service'
import {
  captureCloudSessionMutation,
  cloudSessionIdentity,
  recordCloudSessionIdentityMutationIfCurrent
} from './profile-cloud-session-mutation'
import { runWithFreshMCodeCloudSession } from './profile-cloud-session-refresh'
import { readMCodeCloudSession, saveMCodeCloudSessionIfCurrent } from './profile-cloud-session-store'

export async function refreshCurrentMCodeProfileAuth(
  userDataPath: string
): Promise<RefreshCurrentMCodeProfileAuthResult> {
  const active = ensureActiveMCodeProfile(userDataPath)
  const auth = () => getMCodeProfileAuthStatusFromProfile(active, userDataPath)
  if (!active.profile.cloud) {
    return { status: 'local', auth: auth() }
  }
  if (isMCodeCloudDevAuthEnabled()) {
    const result = refreshDevMCodeCloudProfile(active, userDataPath)
    if (result.status !== 'updated') {
      return { status: 'reconnect-required', auth: auth() }
    }
    return {
      status: 'refreshed',
      auth: auth(),
      activeProfileId: result.list.activeProfileId,
      profiles: result.list.profiles
    }
  }
  const configState = getMCodeCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured', auth: auth() }
  }
  try {
    const identity = cloudSessionIdentity(active.profile.id, active.profile.cloud)
    let mutationSnapshot = captureCloudSessionMutation(identity, userDataPath)
    const operation = await runWithFreshMCodeCloudSession(
      configState.config,
      active,
      userDataPath,
      (session) => refreshMCodeCloudCapabilities(configState.config, session)
    )
    if (operation.status !== 'ok') {
      return { status: 'reconnect-required', auth: auth() }
    }
    const refresh = operation.value
    if (refresh.cloud) {
      const refreshedIdentity = cloudSessionIdentity(active.profile.id, refresh.cloud)
      if (
        refreshedIdentity.cloudUserId !== identity.cloudUserId ||
        refreshedIdentity.cloudProfileId !== identity.cloudProfileId
      ) {
        throw new Error('mcode_cloud_identity_changed_during_capability_refresh')
      }
      if (refreshedIdentity.organizationId !== identity.organizationId) {
        const advanced = recordCloudSessionIdentityMutationIfCurrent(
          refreshedIdentity,
          userDataPath,
          mutationSnapshot
        )
        if (!advanced) {
          return { status: 'reconnect-required', auth: auth() }
        }
        mutationSnapshot = advanced
      }
    }
    const session = readMCodeCloudSession(active.profile.id, userDataPath)
    if (session.status !== 'found') {
      return { status: 'reconnect-required', auth: auth() }
    }
    if (
      saveMCodeCloudSessionIfCurrent(
        active.profile.id,
        userDataPath,
        {
          ...session.session,
          organizations: refresh.organizations ?? session.session.organizations,
          capabilities: refresh.capabilities
        },
        mutationSnapshot
      ) === null
    ) {
      return { status: 'reconnect-required', auth: auth() }
    }
    const list = refresh.cloud
      ? linkMCodeProfileToCloud(active.profile.id, refresh.cloud, userDataPath)
      : getMCodeProfileListState(userDataPath)
    return {
      status: 'refreshed',
      auth: getMCodeProfileAuthStatusFromProfile(
        ensureActiveMCodeProfile(userDataPath),
        userDataPath
      ),
      activeProfileId: list.activeProfileId,
      profiles: list.profiles
    }
  } catch (error) {
    return {
      status: 'failed',
      auth: auth(),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
