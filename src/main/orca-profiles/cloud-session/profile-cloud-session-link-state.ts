import type {
  OrcaCloudCapabilities,
  OrcaCloudOrgSummary,
  OrcaProfileCloudSummary,
  OrcaProfileListState
} from '../../../shared/orca-profiles/orca-profiles'
import { linkOrcaProfileToCloudAsync } from '../cloud-auth/profile-cloud-index'
import { loadOrCreateProfileIndexAsync } from '../profile-index-store-async'
import { orcaCloudSessionKey, type OrcaCloudSession } from './profile-cloud-session-store'
import type { OrcaCloudSessionExchangeResponse } from './profile-cloud-session-exchange'

// All session reads/writes pass through this owner; callers request changes instead of replacing state.

export type SessionOwnerState = {
  // Sign-in/out fences older in-flight changes.
  generation: number
  fenceVersion: number
  // Org changes invalidate old metadata replies, but their rotated tokens must still land.
  linkVersion: number
  // Ignore disk after sign-out even if deletion failed.
  signedOut: boolean
}

export type CloudSessionTicket = { generation: number; linkVersion: number }

export type CloudSessionServerReply = {
  cloud?: OrcaProfileCloudSummary
  organizations?: OrcaCloudOrgSummary[]
  capabilities: OrcaCloudCapabilities
}

const owners = new Map<string, SessionOwnerState>()

export function ownerOf(profileId: string, userDataPath: string): SessionOwnerState {
  const key = orcaCloudSessionKey(profileId, userDataPath)
  let owner = owners.get(key)
  if (!owner) {
    owner = { generation: 0, fenceVersion: 0, linkVersion: 0, signedOut: false }
    owners.set(key, owner)
  }
  return owner
}

export async function isSameOrgAsLink(
  profileId: string,
  userDataPath: string,
  cloud: OrcaProfileCloudSummary
): Promise<boolean> {
  const linked = (await loadOrCreateProfileIndexAsync(userDataPath)).profiles.find(
    (profile) => profile.id === profileId
  )?.cloud
  return (linked?.activeOrgId ?? '') === (cloud.activeOrgId ?? '')
}

export async function relink(
  owner: SessionOwnerState,
  profileId: string,
  userDataPath: string,
  cloud: OrcaProfileCloudSummary
): Promise<OrcaProfileListState> {
  const orgChanged = !(await isSameOrgAsLink(profileId, userDataPath, cloud))
  const list = await linkOrcaProfileToCloudAsync(profileId, cloud, userDataPath)
  if (orgChanged) {
    owner.linkVersion++
  }
  return list
}

/** Take before requests whose replies mutate the session. */
export function takeCloudSessionTicket(
  profileId: string,
  userDataPath: string
): CloudSessionTicket {
  const owner = ownerOf(profileId, userDataPath)
  return { generation: owner.generation, linkVersion: owner.linkVersion }
}

export function sessionFromExchange(exchange: OrcaCloudSessionExchangeResponse): OrcaCloudSession {
  return {
    accessToken: exchange.accessToken,
    refreshToken: exchange.refreshToken,
    expiresAt: exchange.expiresAt,
    organizations: exchange.organizations,
    capabilities: exchange.capabilities,
    identity: { userId: exchange.cloud.userId, cloudProfileId: exchange.cloud.cloudProfileId }
  }
}

export function invalidateCloudSessionChanges(profileId: string, userDataPath: string): void {
  const owner = ownerOf(profileId, userDataPath)
  owner.fenceVersion++
  advanceCloudSessionGeneration(owner)
}

export function advanceCloudSessionGeneration(owner: SessionOwnerState): void {
  owner.generation++
  owner.linkVersion++
}
