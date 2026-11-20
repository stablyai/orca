import { startSpan } from '../../observability/tracer'
import type { JournalSqlTiming } from './journal-sql-protocol'

const WINDOW_MS = 30_000
const SLOW_MS = 1_000

type Window = {
  startedAt: number
  writes: number
  slow: number
  maxRoundTripMs: number
  maxWaitMs: number
  maxGateMs: number
  maxRunMs: number
  maxDepth: number
  maxBatch: number
  maxWalFrames: number
  slowestRunOp: string
}

/** One span per window in which a writer acknowledgement took over a second, naming where it waited. */
export class JournalSqlWriterStallReport {
  private window: Window
  private flushing: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly now: () => number = Date.now) {
    this.window = this.open()
  }

  record(roundTripMs: number, timing: JournalSqlTiming | undefined): void {
    const window = this.window
    window.writes++
    window.maxRoundTripMs = Math.max(window.maxRoundTripMs, roundTripMs)
    if (roundTripMs >= SLOW_MS && window.slow++ === 0) {
      // A stall can be the window's last acknowledgement, so report it without waiting for another.
      this.flushing = setTimeout(
        () => this.flush(),
        Math.max(0, WINDOW_MS - (this.now() - window.startedAt))
      )
      this.flushing.unref?.()
    }
    if (timing) {
      window.maxWaitMs = Math.max(window.maxWaitMs, timing.waitMs)
      window.maxGateMs = Math.max(window.maxGateMs, timing.gateMs)
      if (timing.runMs > window.maxRunMs) {
        window.maxRunMs = timing.runMs
        window.slowestRunOp = timing.op
      }
      window.maxDepth = Math.max(window.maxDepth, timing.depth)
      window.maxBatch = Math.max(window.maxBatch, timing.batch)
      window.maxWalFrames = Math.max(window.maxWalFrames, timing.walFrames)
    }
    if (this.now() - window.startedAt >= WINDOW_MS) {
      this.flush()
    }
  }

  private flush(): void {
    clearTimeout(this.flushing)
    this.flushing = undefined
    const window = this.window
    this.window = this.open()
    if (window.slow === 0) {
      return
    }
    startSpan('agentSession.journal-writer-slow', {
      attributes: {
        kind: 'agent-session',
        'journal_writer.window_ms': this.now() - window.startedAt,
        'journal_writer.writes': window.writes,
        'journal_writer.slow': window.slow,
        'journal_writer.max_round_trip_ms': Math.round(window.maxRoundTripMs),
        'journal_writer.max_wait_ms': Math.round(window.maxWaitMs),
        'journal_writer.max_gate_ms': Math.round(window.maxGateMs),
        'journal_writer.max_run_ms': Math.round(window.maxRunMs),
        'journal_writer.slowest_run_op': window.slowestRunOp,
        'journal_writer.max_depth': window.maxDepth,
        'journal_writer.max_batch': window.maxBatch,
        'journal_writer.max_wal_frames': window.maxWalFrames
      }
    }).end()
  }

  private open(): Window {
    return {
      startedAt: this.now(),
      writes: 0,
      slow: 0,
      maxRoundTripMs: 0,
      maxWaitMs: 0,
      maxGateMs: 0,
      maxRunMs: 0,
      maxDepth: 0,
      maxBatch: 0,
      maxWalFrames: 0,
      slowestRunOp: ''
    }
  }
}
