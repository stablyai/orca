// Producer-side PTY flow control (notes/terminal-performance-initiative.md §5).
// Main tracks per-PTY renderer-pending chars; past HIGH it asks the provider to
// pause the actual PTY read (node-pty pause() → kernel backpressure → the
// flooding shell blocks on write), and below LOW it resumes. The wide
// HIGH/LOW gap is deliberate hysteresis so a draining queue cannot flap
// pause/resume once per flush slice.

export const PRODUCER_FLOW_HIGH_WATERMARK_CHARS = 256 * 1024
export const PRODUCER_FLOW_LOW_WATERMARK_CHARS = 32 * 1024
// Why: the daemon auto-resumes a pause after its 5s lost-resume failsafe. If
// pending is still above HIGH after that window, the pause must be re-asserted
// or a sustained flood would run unthrottled after the first failsafe fires.
export const PRODUCER_PAUSE_REASSERT_INTERVAL_MS = 5_000

export type ProducerFlowControlTransport = {
  pauseProducer: (id: string) => void
  resumeProducer: (id: string) => void
}

export class PtyProducerFlowController {
  private transport: ProducerFlowControlTransport
  private highWatermarkChars: number
  private lowWatermarkChars: number
  private reassertIntervalMs: number
  private pausedAtByPty = new Map<string, number>()

  constructor(
    transport: ProducerFlowControlTransport,
    opts: {
      highWatermarkChars?: number
      lowWatermarkChars?: number
      reassertIntervalMs?: number
    } = {}
  ) {
    this.transport = transport
    this.highWatermarkChars = opts.highWatermarkChars ?? PRODUCER_FLOW_HIGH_WATERMARK_CHARS
    this.lowWatermarkChars = opts.lowWatermarkChars ?? PRODUCER_FLOW_LOW_WATERMARK_CHARS
    this.reassertIntervalMs = opts.reassertIntervalMs ?? PRODUCER_PAUSE_REASSERT_INTERVAL_MS
  }

  /** Reports the current pending chars for a PTY. Fires pause exactly once at
   *  the HIGH crossing (re-asserted only after the failsafe interval) and
   *  resume exactly once when pending drains below LOW. */
  update(id: string, pendingChars: number): void {
    const pausedAt = this.pausedAtByPty.get(id)
    if (pausedAt === undefined) {
      if (pendingChars > this.highWatermarkChars) {
        this.pausedAtByPty.set(id, Date.now())
        this.safePause(id)
      }
      return
    }
    if (pendingChars < this.lowWatermarkChars) {
      this.pausedAtByPty.delete(id)
      this.safeResume(id)
      return
    }
    if (
      pendingChars > this.highWatermarkChars &&
      Date.now() - pausedAt >= this.reassertIntervalMs
    ) {
      this.pausedAtByPty.set(id, Date.now())
      this.safePause(id)
    }
  }

  /** Resumes a PTY if it was paused. For teardown paths (exit, kill) where
   *  the pending bookkeeping is being dropped rather than drained. */
  release(id: string): void {
    if (this.pausedAtByPty.delete(id)) {
      this.safeResume(id)
    }
  }

  /** Resumes every paused PTY. For wholesale bookkeeping wipes (window
   *  destroyed) — a local PTY left paused here would stay wedged forever. */
  releaseAll(): void {
    // Deleting the visited entry during Map key iteration is spec-safe.
    for (const id of this.pausedAtByPty.keys()) {
      this.release(id)
    }
  }

  isPaused(id: string): boolean {
    return this.pausedAtByPty.has(id)
  }

  // Why swallow: pause/resume are optimizations riding the terminal data
  // path — a provider throw must never break delivery or exit handling.
  private safePause(id: string): void {
    try {
      this.transport.pauseProducer(id)
    } catch {
      /* best-effort */
    }
  }

  private safeResume(id: string): void {
    try {
      this.transport.resumeProducer(id)
    } catch {
      /* best-effort */
    }
  }
}
