/** Re-checks user-controlled sessions that may expire or be replaced. */
export class AmphetamineReconcileTimer {
  private handle: ReturnType<typeof setInterval> | null = null

  /** Non-positive intervals disable reconciliation in tests. */
  start(intervalMs: number, onTick: () => void): void {
    if (this.handle || intervalMs <= 0) {
      return
    }
    this.handle = setInterval(onTick, intervalMs)
    if (typeof this.handle.unref === 'function') {
      this.handle.unref()
    }
  }

  stop(): void {
    if (!this.handle) {
      return
    }
    clearInterval(this.handle)
    this.handle = null
  }
}
