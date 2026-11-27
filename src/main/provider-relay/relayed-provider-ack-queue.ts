/**
 * One ack runs with at most one waiting behind it: later asks join the waiting one (a forced ask
 * makes it forced), which reads the output's state only when it runs.
 */
export class RelayedProviderAckQueue {
  private running: Promise<void> = Promise.resolve()
  private waiting: { force: boolean; done: Promise<void> } | null = null

  constructor(private readonly ackNow: (force: boolean) => Promise<void>) {}

  ack(force: boolean): Promise<void> {
    if (this.waiting) {
      this.waiting.force ||= force
      return this.waiting.done
    }
    const next = { force, done: Promise.resolve() }
    next.done = this.running.then(() => {
      if (this.waiting === next) {
        this.waiting = null
      }
      return this.ackNow(next.force)
    })
    this.waiting = next
    this.running = next.done
    return next.done
  }
}
