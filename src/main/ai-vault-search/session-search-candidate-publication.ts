import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { SessionSearchIndexStore, SessionSearchFileRow } from './session-search-store'
import type {
  SessionSearchCandidateCommand,
  SessionSearchCandidateResult
} from './session-search-catalog-candidates'
import { fileIdentity } from './session-search-file-cursor'

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
    store: SessionSearchIndexStore,
    overdue: () => boolean,
    signal?: AbortSignal,
    owed: (candidate: SessionFileCandidate, root: string) => boolean | Promise<boolean> = () =>
      false
  ): Promise<void> {
    await this.request!({ kind: 'publication-next' })
    let consumed = 0
    while (this.publications && (consumed === 0 || !overdue()) && !signal?.aborted) {
      const publication = (await this.request!({ kind: 'publication-next' })).publication
      if (!publication) {
        break
      }
      const page = await this.request!({
        kind: 'group',
        group: publication.group,
        after: publication.cursor
      })
      let cursor = publication.cursor
      let blocked = false
      let failed = false
      for (const row of page.rows) {
        if (signal?.aborted || (consumed > 0 && overdue())) {
          break
        }
        consumed++
        if (publication.phase === 'coverage' && row.selected) {
          await store.prepareCoverage?.([row.candidate.file.path])
          if (await owed(row.candidate, row.root)) {
            await this.requirePublication(row.candidate.file.path)
            blocked = true
            break
          }
          if (row.required || !covered(store, row.candidate)) {
            blocked = true
            break
          }
        } else if (publication.phase === 'withdraw' && !row.selected) {
          const response = await this.request!({
            kind: 'withdraw',
            group: publication.group,
            revision: publication.revision,
            frontier: publication.frontier,
            path: row.candidate.file.path
          })
          if (!response.accepted) {
            failed = true
            break
          }
        }
        cursor = row.key
      }
      const complete = !page.rows.length
      const phase = complete && publication.phase === 'coverage' ? 'withdraw' : publication.phase
      const dirty = !blocked && !(complete && publication.phase === 'withdraw')
      await this.request!({
        kind: 'publication-update',
        group: publication.group,
        revision: publication.revision,
        frontier: publication.frontier,
        cursor: phase !== publication.phase ? '' : cursor,
        phase,
        dirty,
        failed
      })
      if (!page.rows.length) {
        consumed++
      }
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

function covered(store: SessionSearchIndexStore, candidate: SessionFileCandidate): boolean {
  const row = store.fileRow(candidate.file.path)
  const identity = fileIdentity(candidate.file)
  return (
    store.acceptingReads !== false &&
    !!row &&
    row.state === 'current' &&
    row.mtimeMs === candidate.file.mtimeMs &&
    row.byteOffset !== null &&
    row.byteOffset !== undefined &&
    row.byteOffset >= 0 &&
    (candidate.file.sizeBytes === undefined ||
      (row.sizeBytes === candidate.file.sizeBytes &&
        row.byteOffset === candidate.file.sizeBytes)) &&
    (!identity ||
      (!!row.identity && identity.dev === row.identity.dev && identity.ino === row.identity.ino))
  )
}
