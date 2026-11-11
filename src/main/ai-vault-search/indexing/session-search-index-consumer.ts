import { sessionSearchAppendAdmission } from '../session-search-append-admission'
import type {
  SessionSearchCandidatePublications,
  SessionSearchPublicationLease
} from '../session-search-candidate-publication'
import { inSessionParseFileLane } from '../../ai-vault/parse-cache/session-parse-file-lane'
import { requestWholeTranscriptRead } from '../../ai-vault/transcripts/session-transcript-reader'
import { traceSessionSearch } from '../session-search-trace'
import type { AiVaultAgent } from '../../../shared/ai-vault/contracts/ai-vault-types'
import {
  registerTranscriptConsumer,
  type TranscriptConsumer,
  type TranscriptMessage,
  type TranscriptReadConsumer,
  type TranscriptReadOutcome,
  type TranscriptReadStart
} from '../../ai-vault/transcripts/session-transcript-consumers'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import type { SessionSearchFileWrite } from '../storage/session-search-index-writer'
import type {
  SessionSearchResumableCursor,
  SessionSearchIndexStore
} from '../storage/session-search-store-types'

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

/** Proven index gaps need whole reads; declined transfers leave committed coverage unchanged. */
export class SessionSearchIndexConsumer implements TranscriptConsumer {
  constructor(
    private readonly store: SessionSearchIndexStore,
    private readonly onCommitted?: (write: SessionSearchFileWrite) => void,
    private readonly publications?: SessionSearchCandidatePublications
  ) {}

  resumableOffset(candidate: SessionFileCandidate): number | null {
    return this.store.resumableCursor(candidate)?.byteOffset ?? null
  }

  beginRead(start: TranscriptReadStart): SessionSearchReadConsumer | null {
    const { candidate } = start
    if (this.store.acceptingReads === false) {
      return null
    }
    const unprepared = this.store.coverageKnown?.(candidate.file.path) === false
    // A fully covered self-contained transcript has nothing new to publish, even under another agent’s fold.
    if (
      !unprepared &&
      SELF_CONTAINED_TRANSCRIPT_AGENTS[candidate.agent] &&
      (candidate.file.sidecar === undefined || candidate.file.sidecar === 'none') &&
      this.store.coversTranscript(candidate)
    ) {
      return null
    }
    if (!unprepared && start.mode === 'append') {
      const admission = sessionSearchAppendAdmission(
        this.store,
        candidate,
        start.previousByteOffset
      )
      if (admission !== 'target') {
        if (admission === 'lag') {
          if (start.indexing) {
            // Why: invalidate after this lane saves its resume point, before the next read acquires it.
            void inSessionParseFileLane(candidate.file.path, async () =>
              requestWholeTranscriptRead(candidate.file.path)
            ).catch(() => undefined)
          }
          return null
        }
        // A missing span or partial cursor requires a whole read; appending would preserve an index hole.
        this.store.setFileState(candidate.file.path, 'due')
        return null
      }
    }
    // A restart dropped the parser's resume point; append past our cursor once the reread proves the prefix.
    const resume = !unprepared && start.mode === 'replace' ? this.provableCursor(start) : null
    const publication = this.publications?.beginPublication(candidate)
    if (this.publications && !publication) {
      return null
    }
    const signal = publication
      ? start.signal
        ? AbortSignal.any([start.signal, publication.signal])
        : publication.signal
      : start.signal
    const write = unprepared
      ? (this.store.beginUnpreparedWrite?.({ ...start, signal }) ?? null)
      : resume
        ? this.store.beginWrite(
            candidate,
            'append',
            resume.byteOffset,
            start.identity,
            start.indexing,
            signal,
            start.metadataOnly
          )
        : this.store.beginWrite(
            candidate,
            start.mode,
            start.previousByteOffset,
            start.identity,
            start.indexing,
            signal,
            start.metadataOnly
          )
    if (!write) {
      publication?.release()
      return null
    }
    if (publication) {
      publication.signal.addEventListener('abort', () => write.discard(), { once: true })
    }
    return new SessionSearchReadConsumer(
      this.store,
      start,
      write,
      resume,
      this.onCommitted,
      publication ?? undefined
    )
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
    private readonly store: SessionSearchIndexStore,
    private readonly start: TranscriptReadStart,
    private readonly write: SessionSearchFileWrite,
    private readonly resume: SessionSearchResumableCursor | null = null,
    private readonly onCommitted?: (write: SessionSearchFileWrite) => void,
    private readonly publication?: SessionSearchPublicationLease
  ) {}

  async drain(): Promise<void> {
    await this.write.drain?.()
  }

  needsPrefix(offset: number): boolean {
    return this.write.needsPrefix?.(offset) ?? false
  }

  prefixReached(offset: number, digest: string): void {
    this.write.prefixReached?.(offset, digest)
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

  finish(outcome: TranscriptReadOutcome): void | Promise<void> {
    if (
      outcome.cancelled ||
      this.publication?.valid() === false ||
      this.write.cancelled?.() ||
      this.write.failed?.()
    ) {
      // Cancellation must not count toward the failure limit for a healthy file.
      this.write.discard()
      this.publication?.release()
      return
    }
    const { candidate } = this.start
    if (this.resume && !this.prefixProven && !outcome.incomplete) {
      // A rewritten or unreached prefix leaves stale rows; the next pass replaces them.
      this.write.discard()
      traceSessionSearch('commit', () => this.store.setFileState(candidate.file.path, 'due'), {
        append: 0,
        replace: 0,
        rescueRejections: 1,
        rescueRejection: 'prefix-mismatch-or-unreached'
      })
      this.publication?.release()
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
      const acknowledge = (accepted: boolean) => {
        if (accepted && this.publication?.valid() !== false) {
          this.publication?.committed()
          this.onCommitted?.(this.write)
        }
        this.publication?.release()
      }
      if (this.write.settled) {
        return this.write.settled().then(acknowledge, () => acknowledge(false))
      }
      acknowledge(true)
      return
    }
    // Stamp and count repeated read failures so unchanged unreadable files can be held out.
    this.store.setFileState(candidate.file.path, 'failed', candidate.file.mtimeMs)
    this.publication?.release()
  }
}

export function registerSessionSearchIndexConsumer(
  store: SessionSearchIndexStore,
  publications?: SessionSearchCandidatePublications
): () => void {
  return registerTranscriptConsumer(new SessionSearchIndexConsumer(store, undefined, publications))
}
