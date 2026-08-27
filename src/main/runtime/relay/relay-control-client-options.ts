import type WebSocket from 'ws'
import type { E2EEKeypair } from '../e2ee-keypair'
import type { RelayConnectionOpenMessage, RelayDrainMessage } from './relay-control-protocol'

export type RelayControlClientOptions = {
  cellUrl: string
  relayJwt: string
  relayHostId: string
  assignmentEpoch: number
  identity: { userId: string; profileId: string; organizationId: string }
  keypair: E2EEKeypair
  appVersion: string
  previousGeneration?: number
  controlResumeSecret?: string
  onConnectionOpen: (message: RelayConnectionOpenMessage) => void
  onDrain: (message: RelayDrainMessage) => void
  onClose: (code: number) => void
  createSocket?: (url: string, relayJwt: string) => WebSocket
  connectDeadlineMs?: number
  silenceLimitMs?: number
}
