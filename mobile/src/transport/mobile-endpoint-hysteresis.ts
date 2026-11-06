// Timer probes need 3 successes over 30 s and a 60 s dwell, which keeps a flaky LAN from flapping.
const TIMER_SUCCESSES_REQUIRED = 3
const TIMER_OBSERVATION_MS = 30_000
const MINIMUM_DWELL_MS = 60_000
const FAILURE_COOLDOWN_MS = 60_000
// Joining a new Wi-Fi network is fresh evidence, so 2 successes 3 s apart are enough.
const ARRIVAL_SUCCESSES_REQUIRED = 2
export const ARRIVAL_OBSERVATION_MS = 3_000

export class MobileEndpointHysteresis {
  private consecutiveDirectSuccesses = 0
  private directObservationStartedAt: number | null = null
  private cooldownUntil = 0
  private lastMigrationAt: number
  private arrived = false
  private lastArrivalUpgradeAt = -Infinity

  constructor(startedAt: number) {
    this.lastMigrationAt = startedAt
  }

  recordDirectSuccess(now: number): boolean {
    if (now < this.cooldownUntil) {
      return false
    }
    this.directObservationStartedAt ??= now
    this.consecutiveDirectSuccesses += 1
    const observedMs = now - this.directObservationStartedAt
    if (this.arrived) {
      // Arrival waives the dwell: reconnecting to the relay after a network change also counts as a migration.
      const ready =
        this.consecutiveDirectSuccesses >= ARRIVAL_SUCCESSES_REQUIRED &&
        observedMs >= ARRIVAL_OBSERVATION_MS
      this.arrived = !ready
      if (ready) {
        this.lastArrivalUpgradeAt = now
      }
      return ready
    }
    return (
      this.consecutiveDirectSuccesses >= TIMER_SUCCESSES_REQUIRED &&
      observedMs >= TIMER_OBSERVATION_MS &&
      now - this.lastMigrationAt >= MINIMUM_DWELL_MS
    )
  }

  recordDirectFailure(now: number): void {
    this.arrived = false
    this.resetProgress()
    this.cooldownUntil = now + FAILURE_COOLDOWN_MS
  }

  recordMigration(now: number): void {
    this.lastMigrationAt = now
    this.resetProgress()
  }

  // Lasts until the next direct failure or upgrade. One per dwell, so Wi-Fi at the edge of range can't flap the path.
  recordNetworkArrival(now: number): boolean {
    if (now - this.lastArrivalUpgradeAt < MINIMUM_DWELL_MS) {
      return false
    }
    this.arrived = true
    this.cooldownUntil = 0
    this.resetProgress()
    return true
  }

  isArrival(): boolean {
    return this.arrived
  }

  canProbe(now: number): boolean {
    return now >= this.cooldownUntil
  }

  private resetProgress(): void {
    this.consecutiveDirectSuccesses = 0
    this.directObservationStartedAt = null
  }
}
