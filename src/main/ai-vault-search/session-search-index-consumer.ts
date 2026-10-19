import type { AiVaultAgent } from '../../shared/ai-vault-types'
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

// File-read assumptions are checked by session-search-transcript-dependencies.test.ts.
export const SELF_CONTAINED_TRANSCRIPT_AGENTS = {
  claude: true,
  qoder: true,
  codebuddy: true,
  codex: false, // session_index.jsonl supplies titles.
  gemini: true,
  copilot: true,
  cursor: false, // Sibling chat metadata enriches the transcript.
  antigravity: false, // Workspace history enriches the transcript separately.
  opencode: false, // SQLite or a separate message directory.
  opencode2: false,
  zcode: false,
  grok: false, // chat_history.jsonl supplies messages.
  hermes: true,
  rovo: false, // session_context.json supplies messages.
  openclaw: true,
  pi: true,
  omp: true,
  'prime-agent': true,
  droid: true,
  cline: false, // A .messages.json sidecar supplies messages.
  devin: false, // sessions.db supplies metadata.
  kimi: false, // agents/main/wire.jsonl supplies messages.
  muse: true,
  jcode: true,
  kiro: false // A .jsonl sidecar supplies messages.
} satisfies Record<AiVaultAgent, boolean>

/**
 * The search index as a consumer of the transcript reader.
 *
 * It keeps its own cursor in the `files` table and never consults the parse
 * cache: the two answer different questions and diverge the moment either
 * declines a read.
 *
 * Every refusal leaves the cursor where it was and writes what the next pass
 * needs on the row itself, because the row is the only thing that outlives this
 * read. A declined append is `due`: the index is behind on a span no append
 * reaches, so the file has to be read whole. A read that started and did not
 * commit is `failed`, counted, and stamped with the stat it failed at, which is
 * what stops an unreadable transcript being retried on every pass for ever.
 */
export class SessionSearchIndexConsumer implements TranscriptConsumer {
  constructor(private readonly store: SessionSearchStore) {}

  beginRead(start: TranscriptReadStart): TranscriptReadConsumer | null {
    const { candidate } = start
    if (
      start.mode === 'replace' &&
      SELF_CONTAINED_TRANSCRIPT_AGENTS[candidate.agent] &&
      (candidate.file.sidecar === undefined || candidate.file.sidecar === 'none') &&
      this.store.coversTranscript(candidate)
    ) {
      return null
    }
    if (start.mode === 'append') {
      const cursor = this.store.indexedFile(candidate.file.path, fileIdentity(candidate.file))
      if (!cursor || cursor.byteOffset !== start.previousByteOffset) {
        // This index never saw the span before `previousByteOffset`; appending
        // here would leave a hole no later read can fill. A null cursor is the
        // file a chunked read left half written, which no offset continues.
        // Either way the next pass has to read this file from the start.
        this.store.setFileState(candidate.file.path, 'due')
        return null
      }
    }
    const write = this.store.beginWrite(
      candidate,
      start.mode,
      start.previousByteOffset,
      start.identity
    )
    if (!write) {
      // A closed store, a candidate outside the retention window, or a row that
      // moved under this read. Only a row that exists has anything to record.
      this.store.setFileState(candidate.file.path, 'due')
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
      this.write.discard()
      this.store.reportWriteFailure(error)
    }
  }

  finish(outcome: TranscriptReadOutcome): void {
    if (outcome.cancelled) {
      // Leaves the row as it was, which already says what the next pass owes;
      // counting it as a failure would hold a healthy file out after three cancels.
      this.write.discard()
      return
    }
    const { candidate } = this.start
    let committed = false
    try {
      // An incomplete read's rows are not the whole span, so the cursor must not
      // move past them; the file is re-read whole instead.
      committed = !this.failed && !outcome.incomplete && this.write.commit(outcome)
    } catch (error) {
      this.store.reportWriteFailure(error)
    } finally {
      this.write.discard()
    }
    if (committed) {
      this.store.writeCommitted(candidate)
      return
    }
    // Counted against the stat it failed at, not merely recorded: a transcript
    // the reader cannot open fails identically on every pass, and only a change
    // to this stat can mean the file itself changed.
    this.store.setFileState(candidate.file.path, 'failed', candidate.file.mtimeMs)
  }
}

/**
 * Registers the index with the reader and returns the unregister function.
 * Nothing in production calls this yet: PR 3 owns when the index is live.
 */
export function registerSessionSearchIndexConsumer(store: SessionSearchStore): () => void {
  return registerTranscriptConsumer(new SessionSearchIndexConsumer(store))
}
