import {
  ownerOf,
  advanceCloudSessionGeneration,
  invalidateCloudSessionChanges,
  sessionFromExchange
} from './profile-cloud-session-link-state'
import type { OrcaCloudSessionExchangeResponse } from './profile-cloud-session-exchange'
import {
  clearOrcaCloudSession,
  readOrcaCloudSession,
  saveOrcaCloudSession,
  type OrcaCloudSession,
  type OrcaCloudSessionReadResult
} from './profile-cloud-session-store'

export async function readCurrentCloudSession(
  profileId: string,
  userDataPath: string
): Promise<OrcaCloudSessionReadResult> {
  if (ownerOf(profileId, userDataPath).signedOut) {
    return { status: 'missing', persistence: 'none' }
  }
  const session = await readOrcaCloudSession(profileId, userDataPath)
  return ownerOf(profileId, userDataPath).signedOut
    ? { status: 'missing', persistence: 'none' }
    : session
}

/** `requireSealed` refuses memory-only and plaintext saves instead of falling back. */
export async function signInSession(
  profileId: string,
  userDataPath: string,
  exchange: OrcaCloudSessionExchangeResponse,
  options: { requireSealed?: boolean } = {}
): Promise<void> {
  const generation = ownerOf(profileId, userDataPath).generation
  await saveOrcaCloudSession(profileId, userDataPath, sessionFromExchange(exchange), options)
  if (ownerOf(profileId, userDataPath).generation !== generation) {
    throw new Error('orca_cloud_auth_cancelled')
  }
  advanceCloudSessionGeneration(ownerOf(profileId, userDataPath))
  ownerOf(profileId, userDataPath).signedOut = false
}

/** Puts back the session an unfinished account change replaced; with none, signs out. */
export async function restoreSession(
  profileId: string,
  userDataPath: string,
  previous: OrcaCloudSessionReadResult
): Promise<void> {
  if (previous.status === 'found') {
    try {
      await saveOrcaCloudSession(profileId, userDataPath, previous.session)
      advanceCloudSessionGeneration(ownerOf(profileId, userDataPath))
      ownerOf(profileId, userDataPath).signedOut = false
      return
    } catch {
      // The replacement's identity stamp keeps it from being used as the profile's account.
    }
  }
  await signOutSession(profileId, userDataPath)
}

async function signOutSession(profileId: string, userDataPath: string): Promise<void> {
  invalidateCloudSessionChanges(profileId, userDataPath)
  ownerOf(profileId, userDataPath).signedOut = true
  try {
    await clearOrcaCloudSession(profileId, userDataPath)
  } catch {
    // `signedOut` already hides the file, so a revoked token is never read back.
  }
}

// Clear only the token that failed; losing refresh racers must not erase the winner’s session.
export async function signOutRevokedSession(
  profileId: string,
  userDataPath: string,
  failed: OrcaCloudSession
): Promise<boolean> {
  const current = await readCurrentCloudSession(profileId, userDataPath)
  if (current.status === 'found' && current.session.refreshToken !== failed.refreshToken) {
    return false
  }
  // An unreadable token may differ from the failed one, so deletion is unsafe.
  if (current.status === 'unreadable') {
    return false
  }
  await signOutSession(profileId, userDataPath)
  return true
}
