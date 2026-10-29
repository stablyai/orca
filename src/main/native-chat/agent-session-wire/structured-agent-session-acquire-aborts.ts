export class StructuredAgentSessionAcquireAborts {
  private readonly inFlight = new Map<
    string,
    Set<{ controller: AbortController; handover: boolean; goal: boolean; bound?: () => boolean }>
  >()
  /** Starts admitted after quit must begin aborted. */
  private quitReason: Error | null = null

  /** End each handle when its own wait settles. */
  begin(
    sessionId: string,
    handover = false,
    goal = false,
    bound?: () => boolean
  ): { signal: AbortSignal; abort: () => void; end: () => void } {
    const controller = new AbortController()
    if (this.quitReason) {
      controller.abort(this.quitReason)
    }
    const waits =
      this.inFlight.get(sessionId) ??
      new Set<{
        controller: AbortController
        handover: boolean
        goal: boolean
        bound?: () => boolean
      }>()
    const active = { controller, handover, goal, bound }
    waits.add(active)
    this.inFlight.set(sessionId, waits)
    return {
      signal: controller.signal,
      abort: () => controller.abort(new Error('stopped while starting')),
      end: () => {
        waits.delete(active)
        if (waits.size === 0 && this.inFlight.get(sessionId) === waits) {
          this.inFlight.delete(sessionId)
        }
      }
    }
  }

  captureOperations(sessionId: string): (() => void)[] {
    return [...(this.inFlight.get(sessionId) ?? [])]
      .filter(({ controller, goal }) => goal && !controller.signal.aborted)
      .map(
        ({ controller }) =>
          () =>
            controller.abort(new Error('stopped during goal change'))
      )
  }

  abort(sessionId: string, reason: string | Error): { reached: boolean; handedOver: boolean } {
    let reached = false
    let handedOver = false
    for (const { controller, handover, goal } of this.inFlight.get(sessionId) ?? []) {
      reached ||= (handover || goal) && !controller.signal.aborted
      handedOver ||= handover && !controller.signal.aborted
      controller.abort(typeof reason === 'string' ? new Error(reason) : reason)
    }
    return { reached, handedOver }
  }

  /** Called synchronously while the exact ending child is still indexed. */
  abortBound(sessionId: string): void {
    for (const wait of this.inFlight.get(sessionId) ?? []) {
      if (wait.bound?.()) {
        wait.controller.abort(new Error('bound provider child exited'))
      }
    }
  }

  /** Abort all waits, including queued attach-drain work. */
  abortAll(reason: string): void {
    this.quitReason ??= new Error(reason)
    for (const waits of this.inFlight.values()) {
      for (const { controller } of waits) {
        controller.abort(this.quitReason)
      }
    }
  }
}
