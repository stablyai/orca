import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import { ensureActiveOrcaProfile } from '../../orca-profiles/profile-index-store'
import { readFreshOrcaCloudSession } from '../../orca-profiles/profile-cloud-session-refresh'
import type { RelayAuthContext } from './relay-auth-identity'

export async function readRelayAuthContext(
  authConfig: OrcaCloudAuthConfig,
  userDataPath: string
): Promise<RelayAuthContext | null> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (!active.profile.cloud) {
    return null
  }
  const session = await readFreshOrcaCloudSession(authConfig, active, userDataPath)
  if (session.status !== 'found') {
    return null
  }
  // Refresh/org selection can change linkage; derive identity from post-refresh profile state.
  const refreshed = ensureActiveOrcaProfile(userDataPath)
  const cloud = refreshed.profile.cloud
  if (!cloud || refreshed.profile.id !== active.profile.id) {
    return null
  }
  return {
    identity: {
      userId: cloud.userId,
      profileId: cloud.cloudProfileId,
      organizationId: cloud.activeOrgId ?? ''
    },
    accessToken: session.session.accessToken,
    relayEntitled: session.session.capabilities.flags['relay.use'] === true
  }
}
