import type { RelayIdentity } from './relay-session-broker-contract'

export type RelayAuthContext = {
  identity: RelayIdentity
  accessToken: string
  relayEntitled: boolean
}

// The one key that ties brokers, demand and revokes to the account that owns them.
export function relayIdentityKey(identity: RelayIdentity): string {
  return `${identity.userId}\0${identity.profileId}\0${identity.organizationId}`
}
