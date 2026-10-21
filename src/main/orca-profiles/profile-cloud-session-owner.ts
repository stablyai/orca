import type {
  OrcaCloudCapabilities,
  OrcaCloudOrgSummary,
  OrcaProfileCloudSummary,
  OrcaProfileListState
} from '../../shared/orca-profiles'
import { linkOrcaProfileToCloud } from './profile-cloud-index'
import { getOrcaProfileListState, loadOrCreateProfileIndex } from './profile-index-store'
import type { OrcaCloudSessionExchangeResponse } from './profile-cloud-session-exchange'
import {
  clearOrcaCloudSession,
  flushUnsavedOrcaCloudSessions,
  orcaCloudSessionKey,
  readOrcaCloudSession,
  saveOrcaCloudSession,
  type OrcaCloudSession,
  type OrcaCloudSessionReadResult
} from './profile-cloud-session-store'

// The one owner of each profile's cloud session: every read and write of the session goes
// through here. Callers ask for changes; they never write a session they built themselves.

type SessionOwnerState = {
  // Bumped by sign-in and sign-out: a change begun before either may not land.
  generation: number
  // Bumped when the profile's org link moves: a server reply begun before it describes the
  // old org, so only its tokens may land.
  linkVersion: number
  // Signed out this run: the file is ignored even if it could not be removed.
  signedOut: boolean
}

export type CloudSessionTicket = { generation: number; linkVersion: number }

export type CloudSessionServerReply = {
  cloud?: OrcaProfileCloudSummary
  organizations?: OrcaCloudOrgSummary[]
  capabilities: OrcaCloudCapabilities
}

const owners = new Map<string, SessionOwnerState>()

function ownerOf(profileId: string, userDataPath: string): SessionOwnerState {
  const key = orcaCloudSessionKey(profileId, userDataPath)
  let owner = owners.get(key)
  if (!owner) {
    owner = { generation: 0, linkVersion: 0, signedOut: false }
    owners.set(key, owner)
  }
  return owner
}

function isSameOrgAsLink(
  profileId: string,
  userDataPath: string,
  cloud: OrcaProfileCloudSummary
): boolean {
  const linked = loadOrCreateProfileIndex(userDataPath).profiles.find(
    (profile) => profile.id === profileId
  )?.cloud
  return (linked?.activeOrgId ?? '') === (cloud.activeOrgId ?? '')
}

function relink(
  owner: SessionOwnerState,
  profileId: string,
  userDataPath: string,
  cloud: OrcaProfileCloudSummary
): OrcaProfileListState {
  const orgChanged = !isSameOrgAsLink(profileId, userDataPath, cloud)
  const list = linkOrcaProfileToCloud(profileId, cloud, userDataPath)
  if (orgChanged) {
    owner.linkVersion++
  }
  return list
}

export function readCloudSession(
  profileId: string,
  userDataPath: string
): OrcaCloudSessionReadResult {
  if (ownerOf(profileId, userDataPath).signedOut) {
    return { status: 'missing', persistence: 'none' }
  }
  return readOrcaCloudSession(profileId, userDataPath)
}

// Take before a request whose reply will change the session.
export function takeCloudSessionTicket(
  profileId: string,
  userDataPath: string
): CloudSessionTicket {
  const owner = ownerOf(profileId, userDataPath)
  return { generation: owner.generation, linkVersion: owner.linkVersion }
}

export function signInCloudSession(
  profileId: string,
  userDataPath: string,
  exchange: OrcaCloudSessionExchangeResponse
): void {
  saveOrcaCloudSession(profileId, userDataPath, {
    accessToken: exchange.accessToken,
    refreshToken: exchange.refreshToken,
    expiresAt: exchange.expiresAt,
    organizations: exchange.organizations,
    capabilities: exchange.capabilities
  })
  invalidateCloudSessionChanges(profileId, userDataPath)
  ownerOf(profileId, userDataPath).signedOut = false
}

// Fences off every change in flight, e.g. before sign-out's network revoke.
export function invalidateCloudSessionChanges(profileId: string, userDataPath: string): void {
  const owner = ownerOf(profileId, userDataPath)
  owner.generation++
  owner.linkVersion++
}

export function signOutCloudSession(profileId: string, userDataPath: string): void {
  invalidateCloudSessionChanges(profileId, userDataPath)
  ownerOf(profileId, userDataPath).signedOut = true
  try {
    clearOrcaCloudSession(profileId, userDataPath)
  } catch {
    // `signedOut` already hides the file, so a revoked token is never read back.
  }
}

// Why: with rotation, only the session that actually failed may be cleared; a loser of a
// concurrent refresh race must not wipe the winner's rotated session. Returns whether it cleared.
export function signOutRevokedCloudSession(
  profileId: string,
  userDataPath: string,
  failed: OrcaCloudSession
): boolean {
  const current = readCloudSession(profileId, userDataPath)
  if (current.status === 'found' && current.session.refreshToken !== failed.refreshToken) {
    return false
  }
  // A session we were denied is not a session we may delete: the token we would be clearing
  // might not even be the one that failed.
  if (current.status === 'unreadable') {
    return false
  }
  signOutCloudSession(profileId, userDataPath)
  return true
}

/**
 * Lands a refresh reply. Why the tokens always land unless the session was signed out or
 * replaced: the token we sent is spent once the server rotates, and keeping it means the next
 * refresh replays it and the server revokes the family. Orgs, capabilities and the link follow
 * only when the org link did not move meanwhile; the link is best effort, after the tokens.
 */
export function commitCloudSessionRotation(
  profileId: string,
  userDataPath: string,
  ticket: CloudSessionTicket,
  spent: OrcaCloudSession,
  rotated: OrcaCloudSessionExchangeResponse
): OrcaCloudSession | null {
  const owner = ownerOf(profileId, userDataPath)
  const current = readCloudSession(profileId, userDataPath)
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
    ? { ...tokens, organizations: rotated.organizations, capabilities: rotated.capabilities }
    : { ...current.session, ...tokens }
  saveOrcaCloudSession(profileId, userDataPath, next, { spentOnFailure: true })
  if (linkUnmoved) {
    try {
      relink(owner, profileId, userDataPath, rotated.cloud)
    } catch {
      // The tokens are saved; the link is retried by the next refresh or org change.
    }
  }
  return next
}

// Org selection moves the link before its request, so a refresh already in flight lands
// only its tokens and cannot relink to the old org.
export function beginCloudSessionRelink(
  profileId: string,
  userDataPath: string
): CloudSessionTicket {
  ownerOf(profileId, userDataPath).linkVersion++
  return takeCloudSessionTicket(profileId, userDataPath)
}

function commitServerReply(
  profileId: string,
  userDataPath: string,
  ticket: CloudSessionTicket,
  reply: CloudSessionServerReply,
  acceptsSameOrg: boolean
): OrcaProfileListState | null {
  const owner = ownerOf(profileId, userDataPath)
  const current = readCloudSession(profileId, userDataPath)
  const linkMoved =
    owner.linkVersion !== ticket.linkVersion &&
    !(acceptsSameOrg && reply.cloud && isSameOrgAsLink(profileId, userDataPath, reply.cloud))
  if (owner.generation !== ticket.generation || current.status !== 'found' || linkMoved) {
    return null
  }
  saveOrcaCloudSession(profileId, userDataPath, {
    ...current.session,
    organizations: reply.organizations ?? current.session.organizations,
    capabilities: reply.capabilities
  })
  return reply.cloud
    ? relink(owner, profileId, userDataPath, reply.cloud)
    : getOrcaProfileListState(userDataPath)
}

/**
 * Lands an org-selection reply; tokens are untouched. A link that already moved to the
 * selected org still counts as done.
 */
export function commitCloudSessionRelink(
  profileId: string,
  userDataPath: string,
  ticket: CloudSessionTicket,
  reply: CloudSessionServerReply
): OrcaProfileListState | null {
  return commitServerReply(profileId, userDataPath, ticket, reply, true)
}

/** Lands a capability reply; refused if the org link moved at all since the ticket. */
export function commitCloudSessionCapabilities(
  profileId: string,
  userDataPath: string,
  ticket: CloudSessionTicket,
  reply: CloudSessionServerReply
): OrcaProfileListState | null {
  return commitServerReply(profileId, userDataPath, ticket, reply, false)
}

// Writes any rotation still held only in memory; called on quit and OS shutdown.
export function flushUnsavedCloudSessions(): void {
  flushUnsavedOrcaCloudSessions()
}
