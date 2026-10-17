import { startSpan } from '../../observability/tracer'

/** Writes one trace line; `connection` is the short per-connection tag, never a device credential. */
export type MobileClientTraceSink = (connection: string, line: string) => void

export const MOBILE_CLIENT_TRACE_WINDOW_MS = 10 * 60_000
export const MOBILE_CLIENT_TRACE_WINDOW_LINES = 300

// Why both: the span lands in <userData>/logs/main.trace.ndjson (the packaged GUI process has no
// console), and the console line is what `orca serve` and dev runs show.
function writeToMainLog(connection: string, line: string): void {
  startSpan('mobile.client', { attributes: { connection, line } }).end()
  console.info(`[mobile-client] ${connection} ${line}`)
}

/**
 * The rate-limited writer every mobile client trace shares. A phone stuck in a reconnect loop
 * opens a fresh connection every few seconds, so the budget is per process, not per connection.
 */
export class MobileClientTraceLog {
  private readonly sink: MobileClientTraceSink
  private readonly now: () => number
  private windowStartedAt: number | null = null
  private windowLines = 0
  private dropped = 0

  constructor(options: { sink?: MobileClientTraceSink; now?: () => number } = {}) {
    this.sink = options.sink ?? writeToMainLog
    this.now = options.now ?? Date.now
  }

  /** `unbudgeted` is for lines bounded by something else, like one per bundle download. */
  write(connection: string, line: string, options?: { unbudgeted?: boolean }): void {
    const now = this.now()
    if (
      this.windowStartedAt === null ||
      now - this.windowStartedAt >= MOBILE_CLIENT_TRACE_WINDOW_MS
    ) {
      if (this.dropped > 0) {
        this.emit('-', `rate limit dropped ${this.dropped} lines in the previous window`)
      }
      this.windowStartedAt = now
      this.windowLines = 0
      this.dropped = 0
    }
    if (!options?.unbudgeted) {
      if (this.windowLines >= MOBILE_CLIENT_TRACE_WINDOW_LINES) {
        this.dropped += 1
        return
      }
      this.windowLines += 1
      if (this.windowLines === MOBILE_CLIENT_TRACE_WINDOW_LINES) {
        this.emit(connection, line)
        this.emit('-', 'rate limit reached; dropping lines until the window ends')
        return
      }
    }
    this.emit(connection, line)
  }

  private emit(connection: string, line: string): void {
    try {
      this.sink(connection, line)
    } catch {
      // Diagnostics must never fail the RPC or socket event they describe.
    }
  }
}
