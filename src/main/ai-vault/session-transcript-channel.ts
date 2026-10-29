import {
  hasTranscriptConsumers,
  transcriptConsumers,
  type TranscriptMessage,
  type TranscriptMessageSink,
  type TranscriptReadConsumer,
  type TranscriptReadOutcome,
  type TranscriptReadStart
} from './session-transcript-consumers'

/** Cached folds and clones share one channel; each read replaces only its consumers. */
export class TranscriptMessageChannel implements TranscriptMessageSink {
  private readers: TranscriptReadConsumer[] = []
  private start: TranscriptReadStart | null = null
  private emitted = false

  private muted = false

  get active(): boolean {
    return this.readers.length > 0
  }

  beginRead(start: TranscriptReadStart): void {
    this.start = start
    this.emitted = false
    this.muted = false
    this.readers = []
    if (!hasTranscriptConsumers()) {
      return
    }
    for (const consumer of transcriptConsumers()) {
      try {
        const reader = consumer.beginRead(start)
        if (reader) {
          this.readers.push(reader)
        }
      } catch {
        // Isolate consumer failures from transcript parsing.
      }
    }
  }

  push(message: TranscriptMessage): void {
    if (this.muted || this.readers.length === 0) {
      return
    }
    this.emitted = true
    // Drop failed consumers without finish(), preventing a cursor commit for a partial stream.
    let index = 0
    while (index < this.readers.length) {
      try {
        this.readers[index].message(message)
        index++
      } catch {
        this.readers.splice(index, 1)
      }
    }
  }

  reset(): void {
    const start = this.start
    if (!start || !this.emitted) {
      return
    }
    this.finishRead({ session: null, byteOffset: 0, incomplete: true, cancelled: true })
    this.beginRead(start)
  }

  /** Synchronously mute display-only partial lines so consumers receive them only once complete. */
  mute<T>(fn: () => T): T {
    const previous = this.muted
    this.muted = true
    try {
      return fn()
    } finally {
      this.muted = previous
    }
  }

  finishRead(outcome: TranscriptReadOutcome): void {
    const readers = this.readers
    this.readers = []
    this.start = null
    this.emitted = false
    this.muted = false
    for (const reader of readers) {
      try {
        reader.finish(outcome)
      } catch {
        // A consumer failure must never fail the session list.
      }
    }
  }
}
