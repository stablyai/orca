// Bumped whenever a cached Orca Cloud sandbox token may no longer speak for the right team or role:
// a team switch commit, or any change to the signed-in user's memberships or roles. Token caches
// compare epochs so a role change (owner -> member -> owner) never reuses a token minted before it.
import type { OrcaCloudOrgSummary } from '../../shared/orca-profiles'

let epoch = 0
const membershipSignatures = new Map<string, string>()

export function getOrcaCloudTokenEpoch(): number {
  return epoch
}

export function bumpOrcaCloudTokenEpoch(): void {
  epoch += 1
}

function membershipSignature(organizations: readonly OrcaCloudOrgSummary[] | undefined): string {
  return (organizations ?? [])
    .map((org) => `${org.orgId}:${org.role ?? ''}`)
    .sort()
    .join('|')
}

/** Record a session's memberships; bumps the epoch when they differ from the last ones seen. */
export function noteOrcaCloudMemberships(
  sessionKey: string,
  organizations: readonly OrcaCloudOrgSummary[] | undefined
): void {
  const next = membershipSignature(organizations)
  const previous = membershipSignatures.get(sessionKey)
  membershipSignatures.set(sessionKey, next)
  // First sighting counts as a change: a token minted at startup predates what we now know.
  if (previous !== next) {
    bumpOrcaCloudTokenEpoch()
  }
}

export function forgetOrcaCloudMemberships(sessionKey: string): void {
  if (membershipSignatures.delete(sessionKey)) {
    bumpOrcaCloudTokenEpoch()
  }
}
