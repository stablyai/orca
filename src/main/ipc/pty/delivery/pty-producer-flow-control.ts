// Pause producer reads to backpressure flooding shells; separate high/low watermarks prevent flush-time flapping.

import { LongPauseLogLimiter } from '../../../../shared/terminal/pty/flow-control/long-pause-log-limiter'

export const PRODUCER_FLOW_HIGH_WATERMARK_CHARS = 256 * 1024
export const PRODUCER_FLOW_LOW_WATERMARK_CHARS = 32 * 1024
// Reassert sustained backpressure after the daemon's lost-resume failsafe auto-resumes reads.
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
  // Reasserts refresh pausedAtByPty; this keeps the first pause for the long-pause log.
  private pauseStartedAtByPty = new Map<string, number>()
  private readonly longPauseLog = new LongPauseLogLimiter()

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

  update(id: string, pendingChars: number): void {
    const pausedAt = this.pausedAtByPty.get(id)
    if (pausedAt === undefined) {
      if (pendingChars > this.highWatermarkChars) {
        this.pausedAtByPty.set(id, Date.now())
        this.pauseStartedAtByPty.set(id, Date.now())
        this.safePause(id)
      }
      return
    }
    if (pendingChars < this.lowWatermarkChars) {
      this.pausedAtByPty.delete(id)
      this.logLongPause(id, pendingChars)
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

  /** Teardown discards pending accounting; release any pause even without a normal drain. */
  release(id: string): void {
    if (this.pausedAtByPty.delete(id)) {
      this.pauseStartedAtByPty.delete(id)
      this.safeResume(id)
    }
  }

  /** Window teardown must resume all producers before discarding delivery state. */
  releaseAll(): void {
    for (const id of this.pausedAtByPty.keys()) {
      this.release(id)
    }
  }

  isPaused(id: string): boolean {
    return this.pausedAtByPty.has(id)
  }

  private logLongPause(id: string, pendingChars: number): void {
    const startedAt = this.pauseStartedAtByPty.get(id)
    this.pauseStartedAtByPty.delete(id)
    const pausedMs = startedAt === undefined ? 0 : Date.now() - startedAt
    const suppressed = this.longPauseLog.admit(pausedMs)
    if (suppressed !== null) {
      console.warn(
        `[pty] terminal output paused ${pausedMs}ms waiting on renderer: pty=${id} pendingChars=${pendingChars} suppressedSinceLast=${suppressed}`
      )
    }
  }

  // Flow-control failures must not interrupt delivery or exit handling.
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
