import { SessionInputFrontier } from '../ai-vault/session-input-frontier'
import { SessionObservationRetries } from '../ai-vault/session-observation-retries'
import { fileIdentity } from './session-search-file-cursor'
import type { SessionSearchFileRow, SessionSearchIndexStore } from './session-search-store'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
export type Row = { candidate: SessionFileCandidate; root: string }
export type Group = Row | Map<string, Row>
type Publication = {
  revision: number
  required: Set<string>
  withdrawals?: SessionInputFrontier<string>
}
export type SessionSearchPublicationLease = {
  signal: AbortSignal
  valid(): boolean
  committed(): void
  release(): void
}
export function rows(group: Group | undefined): Row[] {
  return group ? (group instanceof Map ? [...group.values()] : [group]) : []
}
export abstract class SessionSearchCandidatePublications {
  protected readonly groups = new Map<string, Group>()
  protected readonly byPath = new Map<string, string | Set<string>>()
  protected readonly selected = new Map<string, Set<string>>()
  private readonly publications = new Map<string, Publication>()
  private readonly dirtyPublications = new SessionInputFrontier<Publication>()
  private readonly withdrawalRetries = new SessionObservationRetries()
  private readonly readers = new Map<string, Set<AbortController>>()
  private revision = 0

  private owners(path: string): readonly string[] {
    const owner = this.byPath.get(path)
    return typeof owner === 'string' ? [owner] : [...(owner ?? [])]
  }
  private isSelected(path: string): boolean {
    return this.owners(path).some((key) => {
      const group = this.groups.get(key)
      return group instanceof Map
        ? this.selected.get(key)?.has(path)
        : group?.candidate.file.path === path
    })
  }
  beginPublications(wake: boolean): void {
    this.withdrawalRetries.begin(wake)
    if (wake) {
      for (const key of this.withdrawalRetries.keys()) {
        const publication = this.publications.get(key)
        if (publication) {
          this.dirtyPublications.set(key, publication)
        }
      }
    }
  }
  get pendingPublications(): boolean {
    return this.dirtyPublications.size > 0
  }
  requirePublication(path: string): void {
    for (const key of this.owners(path)) {
      const publication = this.publications.get(key)
      if (publication && this.selected.get(key)?.has(path)) {
        publication.required.add(path)
        publication.withdrawals = undefined
        this.dirtyPublications.set(key, publication)
      }
    }
  }
  rowChanged(path: string, row: SessionSearchFileRow | undefined): void {
    for (const key of this.owners(path)) {
      const publication = this.publications.get(key)
      if (publication) {
        if (this.selected.get(key)?.has(path)) {
          publication.withdrawals = undefined
        } else if (row) {
          publication.withdrawals?.set(path, path)
        }
        if (!this.withdrawalRetries.heldOut(key)) {
          this.dirtyPublications.set(key, publication)
        }
      }
    }
  }
  beginPublication(candidate: SessionFileCandidate): SessionSearchPublicationLease | null {
    const path = candidate.file.path
    if (this.byPath.has(path) && !this.isSelected(path)) {
      return null
    }
    const owner = new AbortController()
    const readers = this.readers.get(path) ?? new Set<AbortController>()
    readers.add(owner)
    this.readers.set(path, readers)
    const revisions = new Map(
      this.owners(path).map((key) => [key, this.publications.get(key)?.revision])
    )
    const valid = () =>
      !owner.signal.aborted &&
      (!this.byPath.has(path) || this.isSelected(path)) &&
      this.owners(path).every(
        (key) => revisions.has(key) && revisions.get(key) === this.publications.get(key)?.revision
      )
    return {
      signal: owner.signal,
      valid,
      committed: () => {
        if (!valid()) {
          return
        }
        for (const key of this.owners(path)) {
          const publication = this.publications.get(key)
          if (publication && this.selected.get(key)?.has(path)) {
            publication.required.delete(path)
            publication.withdrawals = undefined
            this.dirtyPublications.set(key, publication)
          }
        }
      },
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
    owed: (candidate: SessionFileCandidate, root: string) => boolean = () => false
  ): Promise<void> {
    const available = this.dirtyPublications.size
    let consumed = 0
    while (this.dirtyPublications.size && consumed < available && (consumed === 0 || !overdue())) {
      if (signal?.aborted) {
        return
      }
      const [key, publication] = this.dirtyPublications.firstEntry()!
      this.dirtyPublications.delete(key)
      consumed++
      if (!this.withdrawalRetries.mayAttempt(key)) {
        if (!this.withdrawalRetries.heldOut(key)) {
          this.dirtyPublications.set(key, publication)
        }
        continue
      }
      const members = rows(this.groups.get(key))
      const selected = this.selected.get(key)
      for (const { candidate, root } of members) {
        if (selected?.has(candidate.file.path) && owed(candidate, root)) {
          publication.required.add(candidate.file.path)
        }
      }
      if (
        !selected?.size ||
        !members
          .filter((row) => selected.has(row.candidate.file.path))
          .every(
            ({ candidate }) =>
              !publication.required.has(candidate.file.path) && this.covered(store, candidate)
          )
      ) {
        continue
      }
      if (!publication.withdrawals) {
        publication.withdrawals = new SessionInputFrontier<string>()
        for (const { candidate } of members) {
          const path = candidate.file.path
          if (!selected.has(path) && store.fileRow(path)) {
            publication.withdrawals.set(path, path)
          }
        }
      }
      const withdrawals = publication.withdrawals
      let attempted = 0
      while (withdrawals.size && (attempted === 0 || !overdue())) {
        if (signal?.aborted || this.publications.get(key) !== publication) {
          return
        }
        const path = withdrawals.first!
        // Another source can still select this physical path.
        if (this.isSelected(path)) {
          withdrawals.delete(path)
          continue
        }
        attempted++
        const accepted = await store.removeFile(path)
        if (
          signal?.aborted ||
          this.publications.get(key) !== publication ||
          publication.withdrawals !== withdrawals ||
          this.isSelected(path)
        ) {
          return
        }
        if (!accepted) {
          this.withdrawalRetries.fail(key)
          break
        }
        withdrawals.delete(path)
        this.withdrawalRetries.delete(key)
      }
      this.dirtyPublications.delete(key)
      if (withdrawals.size && !this.withdrawalRetries.heldOut(key)) {
        this.dirtyPublications.set(key, publication)
      }
    }
  }
  private covered(store: SessionSearchIndexStore, candidate: SessionFileCandidate): boolean {
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
  closePublications(): void {
    for (const readers of this.readers.values()) {
      for (const reader of readers) {
        reader.abort()
      }
    }
    this.readers.clear()
    this.publications.clear()
  }
  protected updatePublications(
    previous: ReadonlyMap<string, ReadonlySet<string>>,
    affectedPaths: Set<string>
  ): void {
    for (const key of previous.keys()) {
      for (const { candidate } of rows(this.groups.get(key))) {
        affectedPaths.add(candidate.file.path)
      }
      if (!(this.groups.get(key) instanceof Map)) {
        this.publications.delete(key)
        this.dirtyPublications.delete(key)
        this.withdrawalRetries.delete(key)
      }
    }
    const changedGroups = new Set(previous.keys())
    for (const path of affectedPaths) {
      for (const reader of this.readers.get(path) ?? []) {
        reader.abort()
      }
      for (const key of this.owners(path)) {
        changedGroups.add(key)
      }
    }
    for (const key of changedGroups) {
      if (this.groups.get(key) instanceof Map) {
        const old = this.publications.get(key)
        const publication = {
          revision: ++this.revision,
          required: new Set(
            [...(old?.required ?? [])].filter((path) => this.selected.get(key)?.has(path))
          )
        }
        this.publications.set(key, publication)
        this.withdrawalRetries.delete(key)
        this.dirtyPublications.set(key, publication)
      }
    }
  }
}
