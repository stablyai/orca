import type { RefreshCurrentOrcaProfileAuthResult } from '../../shared/orca-profiles'
import { getOrcaCloudAuthConfig, isOrcaCloudDevAuthEnabled } from './profile-cloud-auth-config'
import { getOrcaProfileAuthStatusFromProfile } from './profile-cloud-auth-status'
import { refreshOrcaCloudCapabilities } from './profile-cloud-client'
import { linkOrcaProfileToCloud } from './profile-cloud-index'
import { ensureActiveOrcaProfile, getOrcaProfileListState } from './profile-index-store'
import { refreshDevOrcaCloudProfile } from './profile-cloud-dev-service'
import {
  captureCloudSessionMutation,
  cloudSessionIdentity,
  recordCloudSessionIdentityMutationIfCurrent
} from './profile-cloud-session-mutation'
import { runWithFreshOrcaCloudSession } from './profile-cloud-session-refresh'
import { readOrcaCloudSession, saveOrcaCloudSessionIfCurrent } from './profile-cloud-session-store'

export async function refreshCurrentOrcaProfileAuth(
  userDataPath: string
): Promise<RefreshCurrentOrcaProfileAuthResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  const auth = () => getOrcaProfileAuthStatusFromProfile(active, userDataPath)
  if (!active.profile.cloud) {
    return { status: 'local', auth: auth() }
  }
  if (isOrcaCloudDevAuthEnabled()) {
    const result = refreshDevOrcaCloudProfile(active, userDataPath)
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
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured', auth: auth() }
  }
  try {
    const identity = cloudSessionIdentity(active.profile.id, active.profile.cloud)
    let mutationSnapshot = captureCloudSessionMutation(identity, userDataPath)
    const operation = await runWithFreshOrcaCloudSession(
      configState.config,
      active,
      userDataPath,
      (session) => refreshOrcaCloudCapabilities(configState.config, session)
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
        throw new Error('orca_cloud_identity_changed_during_capability_refresh')
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
    const session = readOrcaCloudSession(active.profile.id, userDataPath)
    if (session.status !== 'found') {
      return { status: 'reconnect-required', auth: auth() }
    }
    if (
      saveOrcaCloudSessionIfCurrent(
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
      ? linkOrcaProfileToCloud(active.profile.id, refresh.cloud, userDataPath)
      : getOrcaProfileListState(userDataPath)
    return {
      status: 'refreshed',
      auth: getOrcaProfileAuthStatusFromProfile(
        ensureActiveOrcaProfile(userDataPath),
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
