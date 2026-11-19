import type { SignOutCurrentOrcaProfileResult } from '../../../shared/orca-profiles/orca-profiles'
import { ensureActiveOrcaProfileAsync } from '../profile-index-store-async'
import { getOrcaCloudAuthConfig, isOrcaCloudDevAuthEnabled } from './profile-cloud-auth-config'
import {
  invalidateCloudSessionChanges,
  readCloudSession,
  signOutCloudSession
} from '../cloud-session/profile-cloud-session-owner'
import { revokeOrcaCloudSession } from './profile-cloud-client'
import { unlinkOrcaProfileFromCloudAsync } from './profile-cloud-index'
import { endOrcaCloudSignInProgress } from './profile-cloud-sign-in-progress'
import { clearRelayRegionPreferenceCache } from '../../runtime/mobile-cloud-relay/region-selection/relay-region-preference'
import { getOrcaProfileAuthStatusFromProfile } from './profile-cloud-auth-status'
import * as connectAttempts from './profile-cloud-connect-attempts'

function invalidateOutstandingCloudConnectAttempts(): number {
  const epoch = connectAttempts.supersedeCloudConnectAttempts()
  endOrcaCloudSignInProgress()
  return epoch
}

export async function signOutCurrentOrcaProfile(
  userDataPath: string
): Promise<SignOutCurrentOrcaProfileResult> {
  // Pending browser sign-ins must not relink after explicit sign-out.
  const signOutEpoch = invalidateOutstandingCloudConnectAttempts()
  const active = await ensureActiveOrcaProfileAsync(userDataPath)
  const superseded = () => connectAttempts.cloudConnectLinkEpoch() > signOutEpoch
  const currentResult = async (): Promise<SignOutCurrentOrcaProfileResult> => {
    const current = await ensureActiveOrcaProfileAsync(userDataPath)
    return {
      status: 'signed-out',
      auth: await getOrcaProfileAuthStatusFromProfile(current, userDataPath),
      activeProfileId: current.index.activeProfileId,
      profiles: current.index.profiles
    }
  }
  if (superseded()) {
    return currentResult()
  }
  const configState = getOrcaCloudAuthConfig()
  // Fence before disk/network waits so in-flight work cannot act after sign-out.
  invalidateCloudSessionChanges(active.profile.id, userDataPath)
  const session = await readCloudSession(active.profile.id, userDataPath)
  if (superseded()) {
    return currentResult()
  }
  if (!isOrcaCloudDevAuthEnabled() && configState.configured && session.status === 'found') {
    await revokeOrcaCloudSession(configState.config, session.session).catch(() => undefined)
  }
  if (superseded()) {
    return currentResult()
  }
  await signOutCloudSession(active.profile.id, userDataPath)
  const list = await unlinkOrcaProfileFromCloudAsync(active.profile.id, userDataPath)
  try {
    await clearRelayRegionPreferenceCache(userDataPath)
  } catch {
    // A leftover latency cache must not fail the sign-out itself.
  }
  return {
    status: 'signed-out',
    auth: await getOrcaProfileAuthStatusFromProfile(
      await ensureActiveOrcaProfileAsync(userDataPath),
      userDataPath
    ),
    activeProfileId: list.activeProfileId,
    profiles: list.profiles
  }
}
