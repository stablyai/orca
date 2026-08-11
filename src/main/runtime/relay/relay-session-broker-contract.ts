import type WebSocket from 'ws'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { MobileRelayStatus } from '../../../shared/mobile-relay-status'
import type { E2EEKeypair } from '../e2ee-keypair'
import type { MobileSocketWiring } from '../rpc/mobile-socket-wiring'

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
  onStatus: (status: RelayBrokerStatus) => void
  fetch?: typeof globalThis.fetch
  createControlSocket?: (url: string, relayJwt: string) => WebSocket
  createDataSocket?: (url: string) => WebSocket
  random?: () => number
  now?: () => number
}
