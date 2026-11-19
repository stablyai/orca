import {
  ownerOf,
  advanceCloudSessionGeneration,
  relink,
  isSameOrgAsLink,
  takeCloudSessionTicket,
  sessionFromExchange,
  invalidateCloudSessionChanges,
  type CloudSessionTicket,
  type CloudSessionServerReply
} from './profile-cloud-session-link-state'
export {
  takeCloudSessionTicket,
  sessionFromExchange,
  invalidateCloudSessionChanges
} from './profile-cloud-session-link-state'
export type {
  CloudSessionTicket,
  CloudSessionServerReply
} from './profile-cloud-session-link-state'
import { inCloudSessionOrder, pendingChanges } from './profile-cloud-session-order'
import type { OrcaProfileListState } from '../../../shared/orca-profiles/orca-profiles'
import { getOrcaProfileListState } from '../profile-index-store'
import type { OrcaCloudSessionExchangeResponse } from './profile-cloud-session-exchange'
import {
  clearOrcaCloudSession,
  flushUnsavedOrcaCloudSessions,
  readOrcaCloudSession,
  saveOrcaCloudSession,
  type OrcaCloudSession,
  type OrcaCloudSessionReadResult
} from './profile-cloud-session-store'

async function readCurrentCloudSession(
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
async function signInSession(
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
async function restoreSession(
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
async function signOutRevokedSession(
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

/** Save rotated tokens unless signed out/replaced: retaining spent tokens can revoke the family.
 * Apply org metadata only if the link has not moved; persist tokens before the best-effort link. */
async function rotateSession(
  profileId: string,
  userDataPath: string,
  ticket: CloudSessionTicket,
  spent: OrcaCloudSession,
  rotated: OrcaCloudSessionExchangeResponse
): Promise<OrcaCloudSession | null> {
  const owner = ownerOf(profileId, userDataPath)
  const current = await readCurrentCloudSession(profileId, userDataPath)
  if (
    owner.generation !== ticket.generation ||
    current.status !== 'found' ||
    current.session.refreshToken !== spent.refreshToken
  ) {
    return null
  }
  const tokens = {
    accessToken: rotated.accessToken,
    refreshToken: rotated.refreshToken,
    expiresAt: rotated.expiresAt
  }
  const linkUnmoved = owner.linkVersion === ticket.linkVersion
  const next = linkUnmoved
    ? {
        ...tokens,
        organizations: rotated.organizations,
        capabilities: rotated.capabilities,
        identity: current.session.identity
      }
    : { ...current.session, ...tokens }
  await saveOrcaCloudSession(profileId, userDataPath, next, { spentOnFailure: true })
  if (owner.generation !== ticket.generation) {
    return null
  }
  if (linkUnmoved) {
    try {
      relink(owner, profileId, userDataPath, rotated.cloud)
    } catch {
      // The tokens are saved; the link is retried by the next refresh or org change.
    }
  }
  return next
}

// Move the org link before requesting so in-flight refreshes cannot restore the old org.
export async function beginCloudSessionRelink(
  profileId: string,
  userDataPath: string
): Promise<CloudSessionTicket> {
  return inCloudSessionOrder(profileId, userDataPath, async () => {
    ownerOf(profileId, userDataPath).linkVersion++
    return takeCloudSessionTicket(profileId, userDataPath)
  })
}

async function commitServerReply(
  profileId: string,
  userDataPath: string,
  ticket: CloudSessionTicket,
  reply: CloudSessionServerReply,
  acceptsSameOrg: boolean
): Promise<OrcaProfileListState | null> {
  const owner = ownerOf(profileId, userDataPath)
  const current = await readCurrentCloudSession(profileId, userDataPath)
  const linkMoved =
    owner.linkVersion !== ticket.linkVersion &&
    !(acceptsSameOrg && reply.cloud && isSameOrgAsLink(profileId, userDataPath, reply.cloud))
  if (owner.generation !== ticket.generation || current.status !== 'found' || linkMoved) {
    return null
  }
  await saveOrcaCloudSession(profileId, userDataPath, {
    ...current.session,
    organizations: reply.organizations ?? current.session.organizations,
    capabilities: reply.capabilities
  })
  if (owner.generation !== ticket.generation) {
    return null
  }
  return reply.cloud
    ? relink(owner, profileId, userDataPath, reply.cloud)
    : getOrcaProfileListState(userDataPath)
}

/** Leave tokens untouched; an already-selected org still counts as committed. */
export function commitCloudSessionRelink(
  profileId: string,
  userDataPath: string,
  ticket: CloudSessionTicket,
  reply: CloudSessionServerReply
): Promise<OrcaProfileListState | null> {
  return inCloudSessionOrder(profileId, userDataPath, () =>
    commitServerReply(profileId, userDataPath, ticket, reply, true)
  )
}

/** Refuse capability replies if the org link moved after the ticket. */
export function commitCloudSessionCapabilities(
  profileId: string,
  userDataPath: string,
  ticket: CloudSessionTicket,
  reply: CloudSessionServerReply
): Promise<OrcaProfileListState | null> {
  return inCloudSessionOrder(profileId, userDataPath, () =>
    commitServerReply(profileId, userDataPath, ticket, reply, false)
  )
}

export async function flushUnsavedCloudSessions(): Promise<void> {
  while (pendingChanges.size > 0) {
    await Promise.allSettled(pendingChanges)
  }
  await flushUnsavedOrcaCloudSessions()
}

export function readCloudSession(
  profileId: string,
  userDataPath: string
): Promise<OrcaCloudSessionReadResult> {
  return inCloudSessionOrder(profileId, userDataPath, () =>
    readCurrentCloudSession(profileId, userDataPath)
  )
}
export function signInCloudSession(
  profileId: string,
  userDataPath: string,
  exchange: OrcaCloudSessionExchangeResponse,
  options: { requireSealed?: boolean } = {}
): Promise<void> {
  const fenceVersion = ownerOf(profileId, userDataPath).fenceVersion
  return inCloudSessionOrder(profileId, userDataPath, async () => {
    if (ownerOf(profileId, userDataPath).fenceVersion !== fenceVersion) {
      throw new Error('orca_cloud_auth_cancelled')
    }
    return signInSession(profileId, userDataPath, exchange, options)
  })
}
export function signOutCloudSession(profileId: string, userDataPath: string): Promise<void> {
  invalidateCloudSessionChanges(profileId, userDataPath)
  ownerOf(profileId, userDataPath).signedOut = true
  return inCloudSessionOrder(profileId, userDataPath, async () => {
    ownerOf(profileId, userDataPath).signedOut = true
    try {
      await clearOrcaCloudSession(profileId, userDataPath)
    } catch {
      // The sign-out fence hides tokens even when deletion fails.
    }
  })
}
export function signOutRevokedCloudSession(
  profileId: string,
  userDataPath: string,
  failed: OrcaCloudSession
): Promise<boolean> {
  return inCloudSessionOrder(profileId, userDataPath, () =>
    signOutRevokedSession(profileId, userDataPath, failed)
  )
}
export function commitCloudSessionRotation(
  profileId: string,
  userDataPath: string,
  ticket: CloudSessionTicket,
  spent: OrcaCloudSession,
  rotated: OrcaCloudSessionExchangeResponse
): Promise<OrcaCloudSession | null> {
  return inCloudSessionOrder(profileId, userDataPath, () =>
    rotateSession(profileId, userDataPath, ticket, spent, rotated)
  )
}
export function commitCloudSessionChange<T>(
  profileId: string,
  userDataPath: string,
  change: (session: {
    read: typeof readCurrentCloudSession
    signIn: typeof signInSession
    restore: typeof restoreSession
  }) => Promise<T>
): Promise<T> {
  const fenceVersion = ownerOf(profileId, userDataPath).fenceVersion
  const assertCurrent = () => {
    if (ownerOf(profileId, userDataPath).fenceVersion !== fenceVersion) {
      throw new Error('orca_cloud_auth_cancelled')
    }
  }
  return inCloudSessionOrder(profileId, userDataPath, () => {
    assertCurrent()
    return change({
      read: readCurrentCloudSession,
      signIn: async (...args) => {
        assertCurrent()
        await signInSession(...args)
      },
      restore: async (...args) => {
        assertCurrent()
        await restoreSession(...args)
      }
    })
  })
}
