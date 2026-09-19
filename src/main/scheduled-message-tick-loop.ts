/** Chained timer, not setInterval: a delivery pass can outlive one interval, so
 *  overlapping scans are impossible by construction. */
export class ScheduledMessageTickLoop {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    private readonly pass: () => Promise<void>,
    private readonly intervalMs: number,
    private readonly logger: Pick<Console, 'warn'>
  ) {}

  /** Runs one immediate pass before arming the timer, so messages that came due
   *  while Orca was closed are resolved at launch rather than a full tick later. */
  start(): void {
    void this.run()
  }

  dispose(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async run(): Promise<void> {
    try {
      await this.pass()
    } catch (error) {
      // This loop is the only thing that ever revisits a due message: one throw
      // must not end scheduling for the rest of the session.
      this.logger.warn('[scheduled-messages] tick failed', { error })
    }
    if (this.stopped) {
      return
    }
    this.timer = setTimeout(() => {
      void this.run()
    }, this.intervalMs)
    // Never hold the process open for a scan that has nothing to deliver.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }
}
