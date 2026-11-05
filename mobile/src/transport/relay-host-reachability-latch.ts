import { RelayOuterError } from './mobile-relay-e2ee-link'
import { RelayDirectorHttpError } from './mobile-relay-resume-director'
import {
  relayHostReachabilityForCloseCode,
  type RelayHostReachability
} from './relay-host-reachability'

// A single failure is a blip; the same verdict twice in a row is a state.
const RELAY_HOST_REACHABILITY_STREAK = 2

// One failed relay dial, read as what it says about the desktop. A director 401
// is the same refusal as a cell 4401, delivered before the cell was reached.
export function relayHostReachabilityForFailure(error: Error | null): RelayHostReachability {
  if (error instanceof RelayOuterError) {
    return relayHostReachabilityForCloseCode(error.code)
  }
  if (error instanceof RelayDirectorHttpError && error.status === 401) {
    return 'credential-refused'
  }
  return 'connecting'
}

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

  record(error: Error | null): void {
    // A later unlabelled offline close only lost its reason; retain signed-out until connection.
    if (this.reported === 'signed-out') {
      return
    }
    const next = relayHostReachabilityForFailure(error)
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
