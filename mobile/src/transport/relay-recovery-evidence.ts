import { RelayHostReachabilityLatch } from './relay-host-reachability-latch'
import { RelayPairingRejectionLatch } from './relay-pairing-rejection-latch'
import type { RelayHostReachability } from './relay-host-reachability'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

export type RelayRecoveryReporter = Pick<
  StableLogicalRpcClient,
  'setRecoveryAttempt' | 'setPairingRejected' | 'setRelayHostReachability'
>

// Clear pairing rejection and host reachability together only after authenticated success on either path.
export class RelayRecoveryEvidence {
  private readonly pairingRejection = new RelayPairingRejectionLatch()
  private readonly hostReachability = new RelayHostReachabilityLatch()

  reportTo(
    logical: Pick<RelayRecoveryReporter, 'setPairingRejected' | 'setRelayHostReachability'>
  ): void {
    this.pairingRejection.reportTo(logical.setPairingRejected)
    this.hostReachability.reportTo(logical.setRelayHostReachability)
  }

  record(error: Error | null): void {
    this.pairingRejection.record(error)
    this.hostReachability.record(error)
  }

  assert(reachability: RelayHostReachability): void {
    this.hostReachability.assert(reachability)
  }

  clear(): void {
    this.pairingRejection.clear()
    this.hostReachability.clear()
  }
}
