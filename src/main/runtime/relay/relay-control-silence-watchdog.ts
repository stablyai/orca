// The relay pings every 15s and closes a control after 75s of silence; mirror
// that bound so a dead or server-side-unindexed socket cannot stay "active".
export const RELAY_CONTROL_SILENCE_LIMIT_MS = 75_000

const CHECK_INTERVAL_MS = 15_000

export class RelayControlSilenceWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastInboundAt = 0

  constructor(
    private readonly limitMs: number,
    private readonly onSilence: () => void
  ) {}

  noteInbound(): void {
    this.lastInboundAt = Date.now()
  }

  start(): void {
    this.lastInboundAt = Date.now()
    this.timer = setInterval(() => {
      if (Date.now() - this.lastInboundAt > this.limitMs) {
        this.stop()
        this.onSilence()
      }
    }, CHECK_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
