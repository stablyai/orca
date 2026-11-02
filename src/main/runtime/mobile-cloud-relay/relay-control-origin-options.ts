import type WebSocket from 'ws'
import type { E2EEKeypair } from '../e2ee-keypair'
import type { MobileSocketWiring } from '../rpc/mobile-socket-wiring'
import type { RelayIdentity } from './relay-session-broker-contract'
import type { RelayAssignment } from './relay-http-client'
import type { RelayControlOrigin } from './relay-control-origin'
import type { RelayDrainMessage } from './relay-control-protocol'

export type RelayControlOriginOptions = {
  assignment: RelayAssignment
  relayJwt: string
  relayHostId: string
  identity: RelayIdentity
  keypair: E2EEKeypair
  appVersion: string
  mobileSocketWiring: MobileSocketWiring
  createControlSocket?: (url: string, relayJwt: string) => WebSocket
  createDataSocket?: (url: string) => WebSocket
  onConnectionOwned: (connectionId: string, origin: RelayControlOrigin) => void
  onConnectionReleased: (connectionId: string, origin: RelayControlOrigin) => void
  onDrain: (origin: RelayControlOrigin, message: RelayDrainMessage) => void
  onClose: (origin: RelayControlOrigin, code: number) => void
  onPendingChanged?: (origin: RelayControlOrigin) => void
}
