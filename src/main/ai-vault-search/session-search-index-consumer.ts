import { parserPublishesMessages } from '../ai-vault/session-scanner-agent-parser'
import {
  registerTranscriptConsumer,
  type TranscriptConsumer,
  type TranscriptMessage,
  type TranscriptReadConsumer,
  type TranscriptReadOutcome,
  type TranscriptReadStart
} from '../ai-vault/session-transcript-consumers'
import { fileIdentity } from './session-search-file-cursor'
import type { SessionSearchFileWrite } from './session-search-index-writer'
import type { SessionSearchStore } from './session-search-store'

/**
 * The search index as a consumer of the transcript reader.
 *
 * It keeps its own cursor in the `files` table and never consults the parse
 * cache: the two answer different questions and diverge the moment either
 * declines a read. Three refusals, each of which leaves the cursor where it
 * was and records the file for a later whole re-read:
 *
 * - `beginRead` returns null when this index's cursor is behind the offset an
 *   `append` continues from, or when the file's identity changed.
 * - a buffering failure stops the read's rows without failing the session list.
 * - an `incomplete` outcome never commits; those rows are not the whole span.
 */
export class SessionSearchIndexConsumer implements TranscriptConsumer {
  constructor(private readonly store: SessionSearchStore) {}

  beginRead(start: TranscriptReadStart): TranscriptReadConsumer | null {
    const { candidate } = start
    if (!this.store.acceptsCandidate(candidate)) {
      // A pause is a reason not to write now, not a reason to forget the read.
      // `markStale` applies the retention rule itself, so a candidate that is
      // out of scope rather than merely paused is still dropped here.
      this.store.markStale(candidate)
      return null
    }
    // A parser that decodes where the channel cannot reach it reports every read
    // as incomplete. Declining here is not the same as being behind: no re-read
    // would help, so the file is not recorded either.
    if (!parserPublishesMessages(candidate)) {
      return null
    }
    if (start.mode === 'append') {
      const cursor = this.store.indexedFile(candidate.file.path, fileIdentity(candidate.file))
      if (!cursor || cursor.byteOffset !== start.previousByteOffset) {
        // This index never saw the span before `previousByteOffset`; appending
        // here would leave a hole no later read can fill.
        this.store.markStale(candidate)
        return null
      }
    }
    const write = this.store.beginWrite(candidate, start.mode, start.previousByteOffset)
    if (!write) {
      this.store.markStale(candidate)
      return null
    }
    return new SessionSearchReadConsumer(this.store, start, write)
  }
}

class SessionSearchReadConsumer implements TranscriptReadConsumer {
  private failed = false

  constructor(
    private readonly store: SessionSearchStore,
    private readonly start: TranscriptReadStart,
    private readonly write: SessionSearchFileWrite
  ) {}

  message(message: TranscriptMessage): void {
    if (this.failed) {
      return
    }
    try {
      this.write.add(message)
    } catch (error) {
      // Never throws back into the reader: the channel would drop this consumer
      // for the rest of the read and `finish` would never run. Failing here
      // keeps the whole read on one path — the buffer is dropped and the file is
      // re-read.
      this.failed = true
      this.store.reportWriteFailure(error)
    }
  }

  finish(outcome: TranscriptReadOutcome): void {
    const { candidate } = this.start
    let committed = false
    try {
      // An incomplete read's rows are not the whole span, so the cursor must not
      // move past them; the file is re-read whole instead.
      committed = !this.failed && !outcome.incomplete && this.write.commit(outcome)
    } catch (error) {
      this.store.reportWriteFailure(error)
    }
    if (committed) {
      this.store.writeCommitted(candidate)
      return
    }
    this.store.markStale(candidate)
  }
}

/**
 * Registers the index with the reader and returns the unregister function.
 * Nothing in production calls this yet: PR 3 owns when the index is live.
 */
export function registerSessionSearchIndexConsumer(store: SessionSearchStore): () => void {
  return registerTranscriptConsumer(new SessionSearchIndexConsumer(store))
}
