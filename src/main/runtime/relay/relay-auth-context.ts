import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import { ensureActiveOrcaProfile } from '../../orca-profiles/profile-index-store'
import { readFreshOrcaCloudSession } from '../../orca-profiles/profile-cloud-session-refresh'
import type { RelayAuthContext } from './relay-auth-coordinator'

export async function readRelayAuthContext(
  authConfig: OrcaCloudAuthConfig,
  userDataPath: string
): Promise<RelayAuthContext | null> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (!active.profile.cloud) {
    return null
  }
  const session = await readFreshOrcaCloudSession(authConfig, active, userDataPath)
  // Why throw rather than return null: the coordinator reads null as "the cloud session is gone"
  // and closes every paired phone's relay with signed-out, arming no retry. A session file this
  // process could not read is intact, so the retryable auth_unavailable path is the honest word.
  if (session.status === 'unreadable') {
    throw new Error('orca_cloud_session_unreadable')
  }
  if (session.status !== 'found') {
    return null
  }
  // Why: refresh and org-selection can rewrite cloud linkage while the request
  // is in flight; identity must come from the post-refresh profile state.
  const refreshed = ensureActiveOrcaProfile(userDataPath)
  // Why throw rather than return null, same argument as the unreadable session above:
  // a profile switch landing inside this read is not a sign-out, and null spends the
  // terminal SIGNED_OUT — latched by every paired phone, arming no retry — on a race
  // the switch's own auth mutation re-reads moments later.
  if (refreshed.profile.id !== active.profile.id) {
    throw new Error('orca_profile_switched_during_read')
  }
  const cloud = refreshed.profile.cloud
  if (!cloud) {
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
