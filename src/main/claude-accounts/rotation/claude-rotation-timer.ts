/**
 * One timer at a time; each run picks the delay before the next, or null to stop until poked.
 * Its own timer: usage polling pauses with the window, but limits are reached in the background.
 */
export class RotationTimer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private running = false
  private poked = false

  constructor(
    private readonly run: () => Promise<number | null>,
    private readonly pokeDelayMs: number
  ) {}

  start(delayMs: number): void {
    this.started = true
    this.schedule(delayMs)
  }

  stop(): void {
    this.started = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Runs again soon; a run in progress is followed by another instead. */
  poke(): void {
    if (this.running) {
      this.poked = true
    } else {
      this.schedule(this.pokeDelayMs)
    }
  }

  private schedule(delayMs: number): void {
    if (!this.started) {
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.running = true
      this.poked = false
      void this.run()
        .catch(() => this.pokeDelayMs)
        .then((next) => {
          this.running = false
          if (this.poked) {
            this.schedule(this.pokeDelayMs)
          } else if (next !== null) {
            this.schedule(next)
          }
        })
    }, delayMs)
    this.timer.unref?.()
  }
}
