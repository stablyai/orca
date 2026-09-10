import type { RelayHostCloseReason } from '../../../shared/relay-host-close-reason'
import type { RelayOfflineReason } from './relay-offline-reason'
import type { RelayBrokerStatus } from './relay-session-broker'

export type RelayAuthIdentity = {
  userId: string
  profileId: string
  organizationId: string
}

export function relayAuthIdentityKey(identity: RelayAuthIdentity): string {
  return `${identity.userId}\0${identity.profileId}\0${identity.organizationId}`
}

export type RelayAuthContext = {
  identity: RelayAuthIdentity
  accessToken: string
  relayEntitled: boolean
}

export type CoordinatedRelayBroker = {
  closeNow(hostCloseReason?: RelayHostCloseReason): void
  isLive?(): boolean
  readonly endpoint?: { cellUrl: string } | null
}

export type RelayAuthCoordinatorOptions = {
  readContext: () => Promise<RelayAuthContext | null>
  hasDemand?: (context: RelayAuthContext) => boolean
  openBroker: (input: {
    context: RelayAuthContext
    isCurrent: () => boolean
    refreshAccessToken: () => Promise<string | null>
  }) => Promise<CoordinatedRelayBroker>
  onStatus: (status: RelayBrokerStatus, cellUrl?: string) => void
  lingerMs?: number
  random?: () => number
}

// Why the cause rides on the wait result instead of a separate getter: the
// coordinator keeps reconciling after the wait resolves, so a second read could
// name a reason that belongs to a later epoch.
export type LiveBrokerWaitResult =
  | { broker: CoordinatedRelayBroker }
  | { broker: null; offlineReason: RelayOfflineReason | null }

// skipLinger: a deliberate policy change is not pairing churn, so a broker
// that lost demand closes now instead of holding the ten-minute linger.
export type RelayReconcileOptions = { skipLinger?: boolean }
