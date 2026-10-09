// Acquisition and provider preparation share cancellation, including waits outside the lane: a
// close, a Stop admitted now, quit, or the startup limit aborts them instead of waiting behind a
// provider that may never answer.

export class StructuredAgentSessionAcquireAborts {
  private readonly inFlight = new Map<string, Set<AbortController>>()
  /** Set by quit: the host is going away, so an attach that begins after it starts aborted. */
  private quitReason: Error | null = null

  /** For the attach about to run; `end` once it settles. */
  begin(sessionId: string): { signal: AbortSignal; end: () => void } {
    const controller = new AbortController()
    if (this.quitReason) {
      controller.abort(this.quitReason)
    }
    const waits = this.inFlight.get(sessionId) ?? new Set<AbortController>()
    waits.add(controller)
    this.inFlight.set(sessionId, waits)
    return {
      signal: controller.signal,
      end: () => {
        waits.delete(controller)
        if (waits.size === 0 && this.inFlight.get(sessionId) === waits) {
          this.inFlight.delete(sessionId)
        }
      }
    }
  }

  /** A no-op when the session has nothing in flight. */
  abort(sessionId: string, reason: string | Error): void {
    const error = typeof reason === 'string' ? new Error(reason) : reason
    for (const controller of this.inFlight.get(sessionId) ?? []) {
      controller.abort(error)
    }
  }

  /** Quit: every start under way stops, and so does any the attach drain still runs. */
  abortAll(reason: string): void {
    this.quitReason ??= new Error(reason)
    for (const waits of this.inFlight.values()) {
      for (const controller of waits) {
        controller.abort(this.quitReason)
      }
    }
  }
}
