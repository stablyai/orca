import type { RefreshCurrentOrcaProfileAuthResult } from '../../shared/orca-profiles'
import { getOrcaCloudAuthConfig, isOrcaCloudDevAuthEnabled } from './profile-cloud-auth-config'
import { getOrcaProfileAuthStatusFromProfile } from './profile-cloud-auth-status'
import { refreshOrcaCloudCapabilities } from './profile-cloud-client'
import { ensureActiveOrcaProfile } from './profile-index-store'
import { refreshDevOrcaCloudProfile } from './profile-cloud-dev-service'
import {
  commitCloudSessionCapabilities,
  takeCloudSessionTicket,
  type CloudSessionTicket
} from './profile-cloud-session-owner'
import { runWithFreshOrcaCloudSession } from './profile-cloud-session-refresh'

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
    const cloud = active.profile.cloud
    let ticket: CloudSessionTicket | undefined
    const operation = await runWithFreshOrcaCloudSession(
      configState.config,
      active,
      userDataPath,
      (session) => {
        // Why: take the ticket at request time, after any refresh; that refresh may relink.
        ticket = takeCloudSessionTicket(active.profile.id, userDataPath)
        return refreshOrcaCloudCapabilities(configState.config, session)
      }
    )
    if (operation.status !== 'ok' || !ticket) {
      return { status: 'reconnect-required', auth: auth() }
    }
    const refresh = operation.value
    if (
      refresh.cloud &&
      (refresh.cloud.userId !== cloud.userId ||
        refresh.cloud.cloudProfileId !== cloud.cloudProfileId)
    ) {
      throw new Error('orca_cloud_identity_changed_during_capability_refresh')
    }
    const list = commitCloudSessionCapabilities(active.profile.id, userDataPath, ticket, refresh)
    if (!list) {
      return { status: 'reconnect-required', auth: auth() }
    }
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
