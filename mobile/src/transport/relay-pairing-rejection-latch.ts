import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'

// Why: one E2EE rejection is not proof the pairing is dead — the desktop fires it
// transiently while it commits credentials right after pairing. Mirrors rpc-client's
// AUTH_RETRY_BUDGET so both transports latch "re-pair" on the same weight of evidence.
const RELAY_PAIRING_REJECTION_BUDGET = 3

// Consecutive desktop rejections of this device's relay credential. Only an
// authenticated connection clears it — a gate lift or app resume must not, or a
// revoked phone re-enters the reassuring "Connecting via Relay…" label forever.
export class RelayPairingRejectionLatch {
  private count = 0
  private reporter: ((rejected: boolean) => void) | null = null

  rejected(): boolean {
    return this.count >= RELAY_PAIRING_REJECTION_BUDGET
  }

  reportTo(reporter: (rejected: boolean) => void): void {
    this.reporter = reporter
    reporter(this.rejected())
  }

  // Only an E2EE rejection is evidence; every other relay failure leaves the streak
  // untouched so a flaky network cannot masquerade as a revoked pairing.
  record(error: Error | null): void {
    if (error instanceof MobileE2EEAuthenticationError) {
      this.update(Math.min(this.count + 1, RELAY_PAIRING_REJECTION_BUDGET))
    }
  }

  clear(): void {
    this.update(0)
  }

  private update(count: number): void {
    const wasRejected = this.rejected()
    this.count = count
    if (wasRejected !== this.rejected()) {
      this.reporter?.(this.rejected())
    }
  }
}
