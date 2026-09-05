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
