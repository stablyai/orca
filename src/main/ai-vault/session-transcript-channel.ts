import {
  hasTranscriptConsumers,
  transcriptConsumers,
  type TranscriptMessage,
  type TranscriptMessageSink,
  type TranscriptReadConsumer,
  type TranscriptReadOutcome,
  type TranscriptReadStart
} from './session-transcript-consumers'

/**
 * The sink a parser pushes into, and the fan-out to every registered consumer.
 *
 * One channel belongs to one file for as long as its resumable parse state
 * lives, because the cached state (and every clone of it) holds this reference.
 * A read re-points the channel at that read's consumers instead of replacing it.
 */
export class TranscriptMessageChannel implements TranscriptMessageSink {
  private readers: TranscriptReadConsumer[] = []

  private muted = false

  /** True while a read is open with at least one consumer attached. */
  get active(): boolean {
    return this.readers.length > 0
  }

  beginRead(start: TranscriptReadStart): void {
    this.muted = false
    this.readers = []
    // Keeps a scan with no consumers allocation-free on its hottest path.
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
        // A consumer that cannot open this read simply does not see it.
      }
    }
  }

  push(message: TranscriptMessage): void {
    if (this.muted || this.readers.length === 0) {
      return
    }
    // A throwing consumer is dropped for the rest of the read rather than
    // failing the parse; it then gets no `finish`, so it never records a cursor
    // for a stream it did not see in full.
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

  /**
   * Suppresses emission for a display-only re-read: the trailing unterminated
   * line is shown in the list but is re-read once complete, so emitting it here
   * would hand every consumer the same line twice. `fn` must be synchronous.
   */
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
