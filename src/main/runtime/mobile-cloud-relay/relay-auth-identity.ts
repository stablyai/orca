import type { RelayIdentity } from './relay-session-broker-contract'

export type RelayAuthContext = {
  identity: RelayIdentity
  accessToken: string
  relayEntitled: boolean
}

export function relayIdentityKey(identity: RelayIdentity): string {
  return `${identity.userId}\0${identity.profileId}\0${identity.organizationId}`
}
