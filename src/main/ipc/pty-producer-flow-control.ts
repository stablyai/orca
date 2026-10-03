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
// Why: resume is driven by renderer ACKs draining pending below LOW. If those
// ACKs stop (wedged/lost renderer), pending never drains and a provider without
// its own failsafe — LocalPtyProvider is a bare node-pty pause() — leaves the
// child blocked on write for good, freezing a live agent TUI. Cap one continuous
// paused span; a still-flooded pending re-pauses on the next report.
export const PRODUCER_PAUSE_MAX_HOLD_MS = 10_000

export type ProducerFlowControlTransport = {
  pauseProducer: (id: string) => void
  resumeProducer: (id: string) => void
}

export class PtyProducerFlowController {
  private transport: ProducerFlowControlTransport
  private highWatermarkChars: number
  private lowWatermarkChars: number
  private reassertIntervalMs: number
  private maxPauseHoldMs: number
  private pausedAtByPty = new Map<string, number>()
  private pauseCeilingTimerByPty = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    transport: ProducerFlowControlTransport,
    opts: {
      highWatermarkChars?: number
      lowWatermarkChars?: number
      reassertIntervalMs?: number
      maxPauseHoldMs?: number
    } = {}
  ) {
    this.transport = transport
    this.highWatermarkChars = opts.highWatermarkChars ?? PRODUCER_FLOW_HIGH_WATERMARK_CHARS
    this.lowWatermarkChars = opts.lowWatermarkChars ?? PRODUCER_FLOW_LOW_WATERMARK_CHARS
    this.reassertIntervalMs = opts.reassertIntervalMs ?? PRODUCER_PAUSE_REASSERT_INTERVAL_MS
    this.maxPauseHoldMs = opts.maxPauseHoldMs ?? PRODUCER_PAUSE_MAX_HOLD_MS
  }

  /** Reports the current pending chars for a PTY. Fires pause exactly once at
   *  the HIGH crossing (re-asserted only after the failsafe interval) and
   *  resume exactly once when pending drains below LOW. */
  update(id: string, pendingChars: number): void {
    const pausedAt = this.pausedAtByPty.get(id)
    if (pausedAt === undefined) {
      if (pendingChars > this.highWatermarkChars) {
        this.pausedAtByPty.set(id, Date.now())
        this.armPauseCeiling(id)
        this.safePause(id)
      }
      return
    }
    if (pendingChars < this.lowWatermarkChars) {
      this.pausedAtByPty.delete(id)
      this.clearPauseCeiling(id)
      this.safeResume(id)
      return
    }
    if (
      pendingChars > this.highWatermarkChars &&
      Date.now() - pausedAt >= this.reassertIntervalMs
    ) {
      // Why no re-arm: the ceiling bounds one continuous paused span, so a
      // re-assert must not extend it or a sustained flood would never release.
      this.pausedAtByPty.set(id, Date.now())
      this.safePause(id)
    }
  }

  /** Resumes a PTY if it was paused. For teardown paths (exit, kill) where
   *  the pending bookkeeping is being dropped rather than drained. */
  release(id: string): void {
    this.clearPauseCeiling(id)
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

  private armPauseCeiling(id: string): void {
    this.clearPauseCeiling(id)
    const timer = setTimeout(() => {
      this.pauseCeilingTimerByPty.delete(id)
      // Why unconditional: pending is still above LOW here by construction, so
      // only the ceiling can break the deadlock. Dropping the bookkeeping lets
      // the next report re-pause if the flood is real.
      if (!this.pausedAtByPty.delete(id)) {
        return
      }
      this.safeResume(id)
    }, this.maxPauseHoldMs)
    // Why unref: a pending resume timer must never hold the process open at exit.
    timer.unref?.()
    this.pauseCeilingTimerByPty.set(id, timer)
  }

  private clearPauseCeiling(id: string): void {
    const timer = this.pauseCeilingTimerByPty.get(id)
    if (timer === undefined) {
      return
    }
    clearTimeout(timer)
    this.pauseCeilingTimerByPty.delete(id)
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
