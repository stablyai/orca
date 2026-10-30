import type { AiVaultAgent } from '../../shared/ai-vault-types'
import {
  registerTranscriptConsumer,
  type TranscriptConsumer,
  type TranscriptMessage,
  type TranscriptReadConsumer,
  type TranscriptReadOutcome,
  type TranscriptReadStart
} from '../ai-vault/session-transcript-consumers'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { fileIdentity } from './session-search-file-cursor'
import type { SessionSearchFileWrite } from './session-search-index-writer'
import type { SessionSearchResumableCursor, SessionSearchStore } from './session-search-store'

// File-read assumptions are checked by session-search-transcript-dependencies.test.ts.
export const SELF_CONTAINED_TRANSCRIPT_AGENTS = {
  claude: true,
  qoder: true,
  codebuddy: true,
  codex: false, // session_index.jsonl can override titles.
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

/** Persist index progress independently: declined appends become due, failed reads retry against their stat. */
export class SessionSearchIndexConsumer implements TranscriptConsumer {
  constructor(private readonly store: SessionSearchStore) {}

  resumableOffset(candidate: SessionFileCandidate): number | null {
    return this.store.resumableCursor(candidate)?.byteOffset ?? null
  }

  beginRead(start: TranscriptReadStart): TranscriptReadConsumer | null {
    const { candidate } = start
    // A fully covered self-contained transcript has nothing new to publish, even under another agent’s fold.
    if (
      SELF_CONTAINED_TRANSCRIPT_AGENTS[candidate.agent] &&
      (candidate.file.sidecar === undefined || candidate.file.sidecar === 'none') &&
      this.store.coversTranscript(candidate)
    ) {
      return null
    }
    if (start.mode === 'append') {
      const cursor = this.store.indexedFile(candidate.file.path, fileIdentity(candidate.file))
      if (!cursor || cursor.byteOffset !== start.previousByteOffset) {
        // A missing span or partial cursor requires a whole read; appending would preserve an index hole.
        this.store.setFileState(candidate.file.path, 'due')
        return null
      }
    }
    // A restart dropped the parser's resume point; append past our cursor once the reread proves the prefix.
    const resume = start.mode === 'replace' ? this.provableCursor(start) : null
    const write = resume
      ? this.store.beginWrite(candidate, 'append', resume.byteOffset, start.identity)
      : this.store.beginWrite(candidate, start.mode, start.previousByteOffset, start.identity)
    if (!write) {
      this.store.setFileState(candidate.file.path, 'due')
      return null
    }
    return new SessionSearchReadConsumer(this.store, start, write, resume)
  }

  private provableCursor(start: TranscriptReadStart): SessionSearchResumableCursor | null {
    if (!start.prefixOffsets) {
      return null
    }
    const cursor = this.store.resumableCursor(start.candidate)
    return cursor && start.prefixOffsets.has(cursor.byteOffset) ? cursor : null
  }
}

class SessionSearchReadConsumer implements TranscriptReadConsumer {
  private failed = false
  private prefixProven = false

  constructor(
    private readonly store: SessionSearchStore,
    private readonly start: TranscriptReadStart,
    private readonly write: SessionSearchFileWrite,
    private readonly resume: SessionSearchResumableCursor | null = null
  ) {}

  prefixReached(offset: number, digest: string): void {
    if (this.resume?.byteOffset === offset) {
      this.prefixProven = digest === this.resume.prefixHash
    }
  }

  message(message: TranscriptMessage): void {
    // Until the prefix is proven, messages belong to rows this index already holds.
    if (this.failed || (this.resume && !this.prefixProven)) {
      return
    }
    try {
      this.write.add(message)
    } catch (error) {
      // Keep finish() reachable so failures are recorded; throwing would detach this consumer.
      this.failed = true
      this.write.discard()
      this.store.reportWriteFailure(error)
    }
  }

  finish(outcome: TranscriptReadOutcome): void {
    if (outcome.cancelled) {
      // Cancellation must not count toward the failure limit for a healthy file.
      this.write.discard()
      return
    }
    const { candidate } = this.start
    if (this.resume && !this.prefixProven && !outcome.incomplete) {
      // A rewritten or unreached prefix leaves stale rows; the next pass replaces them.
      this.write.discard()
      this.store.setFileState(candidate.file.path, 'due')
      return
    }
    let committed = false
    try {
      // Incomplete streams cannot advance the index cursor.
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
    // Stamp and count repeated read failures so unchanged unreadable files can be held out.
    this.store.setFileState(candidate.file.path, 'failed', candidate.file.mtimeMs)
  }
}

export function registerSessionSearchIndexConsumer(store: SessionSearchStore): () => void {
  return registerTranscriptConsumer(new SessionSearchIndexConsumer(store))
}
