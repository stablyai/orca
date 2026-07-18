export class MobileRelayRecoveryTimer {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly setTimer: typeof setTimeout,
    private readonly clearTimer: typeof clearTimeout
  ) {}

  get scheduled(): boolean {
    return this.timer !== null
  }

  scheduleIfIdle(delayMs: number, callback: () => void): void {
    if (this.timer) {
      return
    }
    this.schedule(delayMs, callback)
  }

  scheduleBefore(deadline: number, marginMs: number, now: number, callback: () => void): void {
    this.clear()
    this.schedule(Math.max(1000, deadline - now - marginMs), callback)
  }

  clear(): void {
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }

  private schedule(delayMs: number, callback: () => void): void {
    this.timer = this.setTimer(() => {
      this.timer = null
      callback()
    }, delayMs)
  }
}
