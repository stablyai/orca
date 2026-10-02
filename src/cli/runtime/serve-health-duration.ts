export class ServeHealthDuration {
  private healthySince: number | null = null
  private maxConfirmedDurationMs = 0

  accept(): void {
    const now = Date.now()
    this.healthySince ??= now
    this.maxConfirmedDurationMs = Math.max(
      this.maxConfirmedDurationMs,
      Math.max(0, now - this.healthySince)
    )
  }

  interrupt(): void {
    this.healthySince = null
  }

  elapsed(hasHealthProbe: boolean): number {
    // Without probes, readiness remains the only observation of a healthy run.
    return hasHealthProbe
      ? this.maxConfirmedDurationMs
      : this.healthySince === null
        ? 0
        : Math.max(0, Date.now() - this.healthySince)
  }
}
