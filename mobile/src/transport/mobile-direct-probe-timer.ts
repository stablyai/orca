export class MobileDirectProbeTimer {
  private timer: ReturnType<typeof setTimeout> | null = null

  schedule(args: {
    canSchedule: boolean
    delayMs: number
    setTimer: typeof setTimeout
    onTimer: () => void
  }): void {
    if (!args.canSchedule || this.timer) {
      return
    }
    this.timer = args.setTimer(() => {
      this.timer = null
      args.onTimer()
    }, args.delayMs)
  }

  clear(clearTimer: typeof clearTimeout): void {
    if (this.timer) {
      clearTimer(this.timer)
      this.timer = null
    }
  }
}
