import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type {
  SessionSearchIndexStore,
  SessionSearchFileRow
} from './storage/session-search-store-types'
import type {
  SessionSearchCandidateCommand,
  SessionSearchCandidateResult
} from './session-search-catalog-candidates'

export type SessionSearchPublicationLease = {
  signal: AbortSignal
  valid(): boolean
  committed(): void
  release(): void
}

/** Only active reader leases live here; inactive selection and cleanup belong to the writer. */
export abstract class SessionSearchCandidatePublications {
  protected request:
    | ((command: SessionSearchCandidateCommand) => Promise<SessionSearchCandidateResult>)
    | undefined
  private boundStore: SessionSearchIndexStore | undefined
  private changed = 0
  private publications = 0
  private readonly readers = new Map<string, Set<AbortController>>()

  attach(store: SessionSearchIndexStore): void {
    this.boundStore ??= store
    this.request ??= async (command) => {
      const result = await store.candidates(command)
      this.changed = result.pending
      this.publications = result.pendingPublications
      return result
    }
  }
  get pendingPublications(): boolean {
    return this.boundStore?.catalogPending ?? (this.publications > 0 || this.changed > 0)
  }
  get pendingChanges(): boolean {
    return this.changed > 0
  }
  async beginPublications(wake: boolean): Promise<void> {
    await this.request?.({ kind: wake ? 'publication-wake' : 'publication-begin' })
  }
  async requirePublication(path: string, reason?: 'force' | 'metadata'): Promise<void> {
    await this.request?.({ kind: 'require', path, reason })
  }
  rowChanged(_path: string, _row: SessionSearchFileRow | undefined): void {}
  protected invalidate(path: string): void {
    for (const owner of this.readers.get(path) ?? []) {
      owner.abort()
    }
  }
  beginPublication(candidate: SessionFileCandidate): SessionSearchPublicationLease {
    const path = candidate.file.path
    const owner = new AbortController()
    const readers = this.readers.get(path) ?? new Set<AbortController>()
    readers.add(owner)
    this.readers.set(path, readers)
    return {
      signal: owner.signal,
      valid: () => !owner.signal.aborted,
      committed: () => undefined,
      release: () => {
        readers.delete(owner)
        if (!readers.size) {
          this.readers.delete(path)
        }
      }
    }
  }
  async reconcilePublications(
    _store: SessionSearchIndexStore,
    overdue: () => boolean,
    signal?: AbortSignal,
    _owed: (candidate: SessionFileCandidate, root: string) => boolean | Promise<boolean> = () =>
      false
  ): Promise<void> {
    let consumed = 0
    while (
      (consumed === 0 || this.publications) &&
      (consumed === 0 || !overdue()) &&
      !signal?.aborted
    ) {
      const result = await this.request!({ kind: 'publication-step' })
      if (!result.processed) {
        break
      }
      consumed += result.processed
    }
  }

  reset(): void {
    this.closePublications()
    this.request = undefined
    this.boundStore = undefined
    this.changed = 0
    this.publications = 0
  }
  closePublications(): void {
    for (const readers of this.readers.values()) {
      for (const owner of readers) {
        owner.abort()
      }
    }
    this.readers.clear()
  }
}
