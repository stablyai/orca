import type { SshRemotePtyLease } from '../../../../shared/ssh-types'
import type { LegacyRelayClient, LegacyRelayOwnerClaim } from './legacy-relay-client'
import type {
  LegacyRelayEndpoint,
  LegacyRelayEndpointListing
} from '../endpoints/legacy-relay-endpoints'
import type { LegacyRelayPaneOwners } from './legacy-relay-pane-owners'

export type LegacyRelayTargetBridgeDeps = {
  targetId: string
  leases: () => SshRemotePtyLease[]
  /** Only on the relay's word: its exit report, or every relay answered and none holds it. */
  retireLease: (relayPtyId: string, proof: 'exit-observed' | 'absent') => void
  listEndpoints: (signal: AbortSignal) => Promise<LegacyRelayEndpointListing>
  openClient: (
    endpoint: LegacyRelayEndpoint,
    resume: LegacyRelayOwnerClaim | null
  ) => Promise<LegacyRelayClient>
  /** Only a dead socket proves its relay gone; anything else about a failed open is unverifiable. */
  endpointExited: (endpoint: LegacyRelayEndpoint) => Promise<boolean>
  onPanesChanged: () => void
  onData: (ptyId: string, data: string) => void
  onExit: (ptyId: string, code: number) => void
  onTerminalExited: () => void
  /** Ownership survives bridge replacement on reconnect. */
  owners: LegacyRelayPaneOwners
}
