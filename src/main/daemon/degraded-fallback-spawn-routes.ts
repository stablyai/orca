export class DegradedFallbackSpawnRoutes {
  private readonly counts = new Map<string, number>()
  private readonly exited = new Set<string>()

  begin(sessionId: string): void {
    const count = this.counts.get(sessionId) ?? 0
    if (count === 0) {
      this.exited.delete(sessionId)
    }
    this.counts.set(sessionId, count + 1)
  }

  end(sessionId: string): void {
    const remaining = (this.counts.get(sessionId) ?? 1) - 1
    if (remaining > 0) {
      this.counts.set(sessionId, remaining)
      return
    }
    this.counts.delete(sessionId)
    this.exited.delete(sessionId)
  }

  isInFlight(sessionId: string): boolean {
    return this.counts.has(sessionId)
  }

  hasExited(sessionId: string): boolean {
    return this.exited.has(sessionId)
  }

  hasLiveCandidate(sessionId: string): boolean {
    return this.isInFlight(sessionId) && !this.hasExited(sessionId)
  }

  recordExit(sessionId: string): void {
    if (this.isInFlight(sessionId)) {
      this.exited.add(sessionId)
    }
  }

  clear(): void {
    this.counts.clear()
    this.exited.clear()
  }
}
