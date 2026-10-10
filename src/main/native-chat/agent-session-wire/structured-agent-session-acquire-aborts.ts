// The acquire each session has in flight, owned by the host that runs it, or another provider wait
// its queue is on (an option write). The queue runs one step at a time, so a session has at most
// one; a close, a Stop admitted now, quit, or the startup limit aborts it from outside the queue
// instead of waiting behind a provider that may never answer.

export class StructuredAgentSessionAcquireAborts {
  private readonly controllers = new Map<string, AbortController>()
  /** Set by quit: the host is going away, so an attach that begins after it starts aborted. */
  private quitReason: Error | null = null

  /** For the attach about to run; `end` once it settles. */
  begin(sessionId: string): { signal: AbortSignal; end: () => void } {
    const controller = new AbortController()
    if (this.quitReason) {
      controller.abort(this.quitReason)
    }
    this.controllers.set(sessionId, controller)
    return {
      signal: controller.signal,
      end: () => {
        if (this.controllers.get(sessionId) === controller) {
          this.controllers.delete(sessionId)
        }
      }
    }
  }

  /** Whether the session's queue is waiting on a provider now. */
  inFlight(sessionId: string): boolean {
    return this.controllers.has(sessionId)
  }

  /** Whether it aborted a wait; a no-op when the session has nothing in flight. */
  abort(sessionId: string, reason: string | Error): boolean {
    const controller = this.controllers.get(sessionId)
    controller?.abort(typeof reason === 'string' ? new Error(reason) : reason)
    return controller !== undefined
  }

  /** Quit: every start under way stops, and so does any the attach drain still runs. */
  abortAll(reason: string): void {
    this.quitReason ??= new Error(reason)
    for (const controller of this.controllers.values()) {
      controller.abort(this.quitReason)
    }
  }
}
