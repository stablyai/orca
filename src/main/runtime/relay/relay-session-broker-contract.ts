import type WebSocket from 'ws'
import type { MobileRelayProvider } from '../../../shared/mobile-relay-provider'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { MobileRelayStatus } from '../../../shared/mobile-relay-status'
import type { E2EEKeypair } from '../e2ee-keypair'
import type { MobileSocketWiring } from '../rpc/mobile-socket-wiring'
import type { RelayHostCloseReason } from '../../../shared/relay-host-close-reason'
import type { RelayRegion } from './relay-region-preference'
import type { RelayRegionDecision, RelayRegionWindow } from './relay-region-correction-protocol'

export type RelayBrokerStatus = MobileRelayStatus

export type RelayIdentity = {
  userId: string
  profileId: string
  organizationId: string
}

// A refused renewal carries the reason the auth owner already computed, so the
// broker closing first never costs the phone the cause.
export type RelayAccessTokenRefresh =
  | { accessToken: string }
  | { accessToken: null; hostCloseReason?: RelayHostCloseReason }

export type RelaySessionBrokerOptions = {
  authConfig: Pick<OrcaCloudAuthConfig, 'relayDirectorUrl' | 'relayTokenEndpoint'>
  accessToken: string
  identity: RelayIdentity
  keypair: E2EEKeypair
  appVersion: string
  mobileSocketWiring: MobileSocketWiring
  relayProvider?: MobileRelayProvider
  isCurrent: () => boolean
  refreshAccessToken: () => Promise<RelayAccessTokenRefresh>
  resolvePreferredRegion?: () => Promise<RelayRegion | undefined>
  measureRegionDecision?: (window: RelayRegionWindow) => Promise<RelayRegionDecision>
  onAssignedCellActive?: (cellUrl: string) => void
  /** `cellUrl` is absent whenever the host holds no active assignment. */
  onStatus: (status: RelayBrokerStatus, cellUrl?: string) => void
  fetch?: typeof globalThis.fetch
  createControlSocket?: (url: string, relayJwt: string) => WebSocket
  createDataSocket?: (url: string) => WebSocket
  random?: () => number
  now?: () => number
}

export class StaleRelayBrokerError extends Error {
  constructor() {
    super('stale_relay_broker')
  }
}
