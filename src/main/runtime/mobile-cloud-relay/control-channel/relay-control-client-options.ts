import type WebSocket from 'ws'
import type { E2EEKeypair } from '../../rpc/server/pairing/e2ee-keypair'
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
  onPendingChanged?: () => void
  createSocket?: (url: string, relayJwt: string) => WebSocket
  connectDeadlineMs?: number
  /** Arms the path-stall detector (two-path failover); unset keeps liveness exactly as before. */
  onStall?: () => void
  /** Two-path connect race: false means another path won, so this challenge is never answered. */
  claimChallenge?: () => boolean
  // Test seam: deterministic probe jitter.
  livenessRandom?: () => number
}
