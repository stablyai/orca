/** `deferringSince` is non-null exactly while the last pass deferred, so an open
 *  wait counts up to *now* rather than to the previous tick. */
type DeliveryRun = {
  attempts: number
  deferredMs: number
  deferringSince: number | null
}

/** In memory on purpose: a restart is a fresh chance, and persisting either number
 *  would strand a message against conditions that no longer exist. */
export class ScheduledMessageDeliveryState {
  private readonly runs = new Map<string, DeliveryRun>()

  attemptsFor(messageId: string): number {
    return this.runs.get(messageId)?.attempts ?? 0
  }

  recordAttempt(messageId: string): void {
    this.run(messageId).attempts += 1
  }

  beginDeferral(messageId: string, now: number): void {
    const run = this.run(messageId)
    run.deferringSince ??= now
  }

  /** Closes the wait and banks it. Called on every pass that did NOT defer, so a
   *  pane that frees up stops accruing credit. */
  endDeferral(messageId: string, now: number): void {
    const run = this.runs.get(messageId)
    if (!run || run.deferringSince === null) {
      return
    }
    run.deferredMs += now - run.deferringSince
    run.deferringSince = null
  }

  /** Usage-limit waits are not charged against the missed-grace window — waiting
   *  one out is the feature working. */
  deferredMs(messageId: string, now: number): number {
    const run = this.runs.get(messageId)
    if (!run) {
      return 0
    }
    return run.deferredMs + (run.deferringSince === null ? 0 : now - run.deferringSince)
  }

  /** Attempts reset, the deferral credit does not: a limit does not lift because
   *  the user pressed "Send now". */
  forgetAttempts(messageId: string): void {
    const run = this.runs.get(messageId)
    if (run) {
      run.attempts = 0
    }
  }

  /** Rescheduling moves the due moment, which is what the credit was measured
   *  against — so it starts over. */
  forgetDeferrals(messageId: string): void {
    const run = this.runs.get(messageId)
    if (run) {
      run.deferredMs = 0
      run.deferringSince = null
    }
  }

  forget(messageId: string): void {
    this.runs.delete(messageId)
  }

  private run(messageId: string): DeliveryRun {
    const existing = this.runs.get(messageId)
    if (existing) {
      return existing
    }
    const created: DeliveryRun = { attempts: 0, deferredMs: 0, deferringSince: null }
    this.runs.set(messageId, created)
    return created
  }
}
