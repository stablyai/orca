import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type {
  TranscriptMessage,
  TranscriptReadOutcome,
  TranscriptSessionIdentity
} from '../ai-vault/transcripts/session-transcript-consumers'
import type { SessionSearchFileWrite } from './session-search-index-writer'
import type { SessionSearchStore } from './session-search-store'

export type SessionSearchReadEvent =
  | { kind: 'message'; message: TranscriptMessage }
  | { kind: 'prefix'; offset: number; digest: string }

/** Admission uses the writer's saved cursor; a cold foreground reader never guesses coverage. */
export class SessionSearchForegroundWrite {
  readonly target: number | null
  private readonly authority: string
  private readonly expectedHash: string | null
  private write: SessionSearchFileWrite | null = null
  private identity: TranscriptSessionIdentity | null = null
  private covered = false
  private rejected = false

  constructor(
    private readonly store: SessionSearchStore,
    private readonly candidate: SessionFileCandidate,
    mode: 'replace' | 'append',
    offset: number,
    allowCovered: boolean,
    canProvePrefix: boolean
  ) {
    this.authority = store.catalogCandidates.admission(candidate).revision
    const row = store.fileRow(candidate.file.path)
    const resume = mode === 'replace' && canProvePrefix ? store.resumableCursor(candidate) : null
    this.target = row?.state === 'current' ? (resume?.byteOffset ?? null) : null
    this.expectedHash = this.target !== null ? (resume?.prefixHash ?? null) : null
    if (allowCovered && store.coversTranscript(candidate)) {
      this.covered = true
      return
    }
    if (mode === 'append' && row?.byteOffset !== offset) {
      store.setFileState(candidate.file.path, 'due')
      this.rejected = true
      return
    }
    if (this.target === null) {
      this.write = store.beginWrite(candidate, mode, offset, () => this.identity)
      this.rejected = this.write === null
    }
  }

  add(events: SessionSearchReadEvent[], identity: TranscriptSessionIdentity | null): void {
    this.identity = identity
    if (this.store.catalogCandidates.admission(this.candidate).revision !== this.authority) {
      this.discard()
    }
    if (this.rejected || this.covered) {
      return
    }
    for (const event of events) {
      if (event.kind === 'prefix') {
        if (!this.write && this.target === event.offset) {
          if (event.digest !== this.expectedHash) {
            this.rejectPrefix()
            return
          }
          this.write = this.store.beginWrite(
            this.candidate,
            'append',
            event.offset,
            () => this.identity
          )
          this.rejected = this.write === null
        }
      } else {
        this.write?.add(event.message)
      }
    }
  }

  finish(outcome: TranscriptReadOutcome): boolean {
    if (
      this.store.catalogCandidates.admission(this.candidate).revision !== this.authority ||
      outcome.cancelled ||
      outcome.incomplete ||
      this.rejected
    ) {
      this.discard()
      return false
    }
    if (this.covered) {
      return this.store.coversTranscript(this.candidate)
    }
    if (!this.write) {
      this.rejectPrefix()
      return false
    }
    const accepted = this.write.commit(outcome)
    this.write = null
    return accepted
  }

  discard(): void {
    this.write?.discard()
    this.write = null
    this.rejected = true
  }

  private rejectPrefix(): void {
    this.discard()
    this.store.setFileState(this.candidate.file.path, 'due')
  }
}
