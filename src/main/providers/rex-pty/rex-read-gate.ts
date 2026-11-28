// A stalled viewer must not accumulate an unbounded client-side queue. Expiry is
// an endpoint failure, not an acknowledgement and not permission to drop output.
export const REX_DELIVERY_STALL_MS = 10_000

export class RexReadGate {
  private paused = false
  private closed = false
  private since = 0
  private wake?: () => void

  constructor(private readonly stallMs = REX_DELIVERY_STALL_MS) {}

  pause(): void {
    if (!this.paused && !this.closed) {
      this.paused = true
      this.since = Date.now()
    }
  }

  resume(): void {
    this.paused = false
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.resume()
  }

  async wait(): Promise<void> {
    while (this.paused && !this.closed) {
      if (this.wake) {
        throw new Error('Rex delivery requires a single reader')
      }
      const remaining = this.stallMs - (Date.now() - this.since)
      if (remaining <= 0) {
        throw new Error('Rex delivery stalled')
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          this.wake = resolve
          timer = setTimeout(() => reject(new Error('Rex delivery stalled')), remaining)
          timer.unref?.()
        })
      } finally {
        clearTimeout(timer)
        this.wake = undefined
      }
    }
    if (this.closed) {
      throw new Error('Rex delivery closed')
    }
  }
}
