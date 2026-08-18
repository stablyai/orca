import type WebSocket from 'ws'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { MobileRelayStatus } from '../../../shared/mobile-relay-status'
import type { E2EEKeypair } from '../e2ee-keypair'
import type { MobileSocketWiring } from '../rpc/mobile-socket-wiring'
import type { RelayRegion } from './relay-region-preference'

export type RelayBrokerStatus = MobileRelayStatus

export type RelayIdentity = {
  userId: string
  profileId: string
  organizationId: string
}

export type RelaySessionBrokerOptions = {
  authConfig: OrcaCloudAuthConfig
  accessToken: string
  identity: RelayIdentity
  keypair: E2EEKeypair
  appVersion: string
  mobileSocketWiring: MobileSocketWiring
  isCurrent: () => boolean
  refreshAccessToken: () => Promise<string | null>
  resolvePreferredRegion?: () => Promise<RelayRegion | undefined>
  onStatus: (status: RelayBrokerStatus) => void
  fetch?: typeof globalThis.fetch
  createControlSocket?: (url: string, relayJwt: string) => WebSocket
  createDataSocket?: (url: string) => WebSocket
  random?: () => number
  now?: () => number
}
