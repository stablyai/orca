export type EndpointHysteresisOptions = {
  directSuccessesRequired: number
  directObservationMs: number
  failureCooldownMs: number
  minimumDwellMs: number
}

export class MobileEndpointHysteresis {
  private consecutiveDirectSuccesses = 0
  private directObservationStartedAt: number | null = null
  private cooldownUntil = 0
  private lastMigrationAt: number

  constructor(
    startedAt: number,
    private readonly options: EndpointHysteresisOptions
  ) {
    this.lastMigrationAt = startedAt
  }

  recordDirectSuccess(now: number): boolean {
    if (now < this.cooldownUntil) {
      return false
    }
    if (this.consecutiveDirectSuccesses === 0) {
      this.directObservationStartedAt = now
    }
    this.consecutiveDirectSuccesses += 1
    return (
      this.consecutiveDirectSuccesses >= this.options.directSuccessesRequired &&
      this.directObservationStartedAt !== null &&
      now - this.directObservationStartedAt >= this.options.directObservationMs &&
      now - this.lastMigrationAt >= this.options.minimumDwellMs
    )
  }

  recordDirectFailure(now: number): void {
    this.consecutiveDirectSuccesses = 0
    this.directObservationStartedAt = null
    this.cooldownUntil = now + this.options.failureCooldownMs
  }

  recordMigration(now: number): void {
    this.lastMigrationAt = now
    this.consecutiveDirectSuccesses = 0
    this.directObservationStartedAt = null
  }

  canProbe(now: number): boolean {
    return now >= this.cooldownUntil
  }
}
