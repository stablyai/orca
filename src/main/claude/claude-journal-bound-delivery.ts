import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionReadingControl
} from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'

/** Own provider observations until their saved identity input is available. */
export class ClaudeJournalBoundDelivery {
  private pending: ({ run: () => void; bytes: number } | undefined)[] = []
  private entries = 0
  private bytes = 0
  private draining = false
  private closed = false
  private unsubscribe?: () => void
  private control?: StructuredAgentSessionReadingControl
  private paused = false
  onFailure?: (error: Error) => void

  constructor(
    private sink?: StructuredAgentSessionEventSink,
    private readonly published: () => boolean = () => true
  ) {
    this.bind(sink)
  }

  bind(sink: StructuredAgentSessionEventSink | undefined): void {
    this.unsubscribe?.()
    this.sink = sink
    this.unsubscribe = sink?.onJournalBound?.(() => this.flush())
  }

  get ready(): boolean {
    return (
      !this.closed &&
      this.published() &&
      (!this.sink?.onJournalBound || this.sink.journalLinkage?.() !== null)
    )
  }

  bindReadingControl(control: StructuredAgentSessionReadingControl): () => void {
    this.control = control
    if (this.paused) {
      control.pauseReading()
    }
    return () => {
      if (this.control === control) {
        this.control = undefined
      }
    }
  }

  deliver(run: () => void, payload?: unknown): void {
    if (this.closed) {
      return
    }
    if (this.ready && !this.draining) {
      run()
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8') + 64
    if (this.entries >= 1_024 || this.bytes + bytes > 32 * 1024 * 1024) {
      const error = new Error('Claude event delivery capacity exceeded before journal binding')
      this.dispose()
      this.onFailure?.(error)
      throw error
    }
    this.pending.push({ run, bytes })
    this.entries++
    this.bytes += bytes
    this.updateReading()
  }

  interpret<T extends { type: string }>(event: T, handle: (event: T) => void): void {
    if (event.type === 'ended' || event.type === 'retiring') {
      this.dispose()
      handle(event)
    } else if (this.ready) {
      handle(event)
    } else {
      this.deliver(() => handle(event), event)
    }
  }

  flush(): void {
    if (!this.ready || this.draining) {
      this.updateReading()
      return
    }
    this.draining = true
    try {
      while (this.pending.length && !this.closed) {
        const prefix = this.pending
        this.pending = []
        for (let index = 0; index < prefix.length; index++) {
          if (this.closed) {
            break
          }
          const entry = prefix[index]!
          prefix[index] = undefined
          this.entries--
          this.bytes -= entry.bytes
          entry.run()
        }
      }
    } catch (cause) {
      this.dispose()
      const error = cause instanceof Error ? cause : new Error(String(cause))
      if (!this.onFailure) {
        throw error
      }
      this.onFailure(error)
    } finally {
      this.draining = false
      this.updateReading()
    }
  }

  /** Retirement ends uncommitted delivery; it must never replay into a disposed translator. */
  dispose(): void {
    this.closed = true
    this.pending = []
    this.entries = 0
    this.bytes = 0
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.updateReading()
  }

  private updateReading(): void {
    const paused = !this.closed && this.published() && !this.ready
    if (paused !== this.paused) {
      this.paused = paused
      this.control?.[paused ? 'pauseReading' : 'resumeReading']()
    }
  }
}
