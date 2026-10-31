// Bounds how long a single connect/handshake stage may stay in flight (spec S6): no unbounded
// hang if the socket never opens, or a peer opens but never sends e2ee_ready/e2ee_authenticated.
// One timer live at a time — arming a new stage always clears whichever one preceded it.
export class ConnectionStageTimer {
  private timer: ReturnType<typeof setTimeout> | null = null

  arm(timeoutMs: number, onTimeout: () => void): void {
    this.clear()
    this.timer = setTimeout(() => {
      this.timer = null
      onTimeout()
    }, timeoutMs)
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

// Finding #18: repeating tick used by the post-auth liveness watchdog. Restart-safe — calling
// start() again (e.g. on re-authentication) replaces whichever interval preceded it.
export class RepeatingProbeTimer {
  private timer: ReturnType<typeof setInterval> | null = null

  start(intervalMs: number, onTick: () => void): void {
    this.stop()
    this.timer = setInterval(onTick, intervalMs)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
