import type { OrcaProfileAuthStatus } from '../../shared/orca-profiles'
import type { ActiveOrcaProfileState } from './profile-index-store'
import { getOrcaCloudAuthConfig, isOrcaCloudDevAuthEnabled } from './profile-cloud-auth-config'
import { readOrcaCloudSession } from './profile-cloud-session-store'

export function getOrcaProfileAuthStatusFromProfile(
  active: ActiveOrcaProfileState,
  userDataPath: string
): OrcaProfileAuthStatus {
  const configState = getOrcaCloudAuthConfig()
  const devAuthEnabled = isOrcaCloudDevAuthEnabled()
  const configured = configState.configured || devAuthEnabled
  const cloud = active.profile.cloud
  if (!cloud) {
    return {
      activeProfileId: active.profile.id,
      configured,
      state: configured ? 'local' : 'unconfigured',
      persistence: 'none',
      setupMessage: configured ? undefined : configState.setupMessage
    }
  }

  const session = readOrcaCloudSession(active.profile.id, userDataPath)
  if (!configured) {
    return {
      activeProfileId: active.profile.id,
      configured: false,
      state: 'unconfigured',
      persistence: session.status === 'found' ? session.persistence : 'none',
      cloud,
      credentialError: session.status === 'decrypt-failed' ? session.error : undefined,
      setupMessage: configState.setupMessage
    }
  }
  if (session.status === 'found') {
    return {
      activeProfileId: active.profile.id,
      configured,
      state: 'connected',
      persistence: session.persistence,
      cloud,
      organizations: session.session.organizations,
      capabilities: session.session.capabilities
    }
  }

  return {
    activeProfileId: active.profile.id,
    configured,
    state: 'reconnect-required',
    persistence: 'none',
    cloud,
    credentialError: session.status === 'decrypt-failed' ? session.error : undefined
  }
}
