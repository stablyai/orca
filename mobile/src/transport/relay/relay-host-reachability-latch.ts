import type { RelayHostReachability } from './relay-host-reachability'

// A single failure is a blip; the same verdict twice in a row is a state.
const RELAY_HOST_REACHABILITY_STREAK = 2

// Latch consecutive identical failures until authenticated connection; app resume/gate lifts provide no recovery evidence.
export class RelayHostReachabilityLatch {
  private candidate: RelayHostReachability = 'connecting'
  private streak = 0
  private reported: RelayHostReachability = 'connecting'
  private reporter: ((reachability: RelayHostReachability) => void) | null = null

  current(): RelayHostReachability {
    return this.reported
  }

  reportTo(reporter: (reachability: RelayHostReachability) => void): void {
    this.reporter = reporter
    reporter(this.reported)
  }

  record(next: RelayHostReachability): void {
    // A later unlabelled offline close only lost its reason; retain signed-out until connection.
    if (this.reported === 'signed-out') {
      return
    }
    // Unmapped failures break the streak but do not prove the last reported outage ended.
    if (next === 'connecting') {
      this.streak = 0
      return
    }
    this.streak = next === this.candidate ? this.streak + 1 : 1
    this.candidate = next
    if (this.streak >= RELAY_HOST_REACHABILITY_STREAK) {
      this.publish(next)
    }
  }

  // The cell named the reason outright, so there is no streak to earn.
  assert(reachability: RelayHostReachability): void {
    this.candidate = reachability
    this.streak = 0
    this.publish(reachability)
  }

  clear(): void {
    this.candidate = 'connecting'
    this.streak = 0
    this.publish('connecting')
  }

  // Publish unconditionally; LogicalClientConnectionPath.update owns deduplication.
  private publish(reachability: RelayHostReachability): void {
    this.reported = reachability
    this.reporter?.(reachability)
  }
}
