// Why: a host that always sends an unreadable frame must not turn every resubscribe into another reset.
const RESET_INTERVAL_MS = 30_000

// Batch unreadable-frame recovery per interval; defer new streams rather than dropping them. Owners must forget released ids.
export class TerminalUnreadableFrameResets {
  private lastResetAt: number | null = null
  private readonly handledStreamIds = new Set<number>()
  private readonly deferred = new Map<number, () => void>()
  private timer: ReturnType<typeof setTimeout> | null = null

  report(streamId: number, opcode: number, reset: () => void): void {
    if (this.handledStreamIds.has(streamId) || this.deferred.has(streamId)) {
      return
    }
    const now = Date.now()
    const waitMs = this.lastResetAt === null ? 0 : this.lastResetAt + RESET_INTERVAL_MS - now
    console.warn('[terminal-stream] unreadable frame', { streamId, opcode, waitMs })
    if (waitMs <= 0) {
      this.lastResetAt = now
      this.handledStreamIds.add(streamId)
      reset()
      return
    }
    this.deferred.set(streamId, reset)
    this.timer ??= setTimeout(() => this.flushDeferred(), waitMs)
  }

  forget(streamId: number): void {
    this.handledStreamIds.delete(streamId)
    this.deferred.delete(streamId)
    if (this.deferred.size === 0) {
      this.cancelTimer()
    }
  }

  clear(): void {
    this.handledStreamIds.clear()
    this.deferred.clear()
    this.cancelTimer()
  }

  private flushDeferred(): void {
    this.timer = null
    this.lastResetAt = Date.now()
    const resets = [...this.deferred]
    this.deferred.clear()
    for (const [streamId, reset] of resets) {
      this.handledStreamIds.add(streamId)
      reset()
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
