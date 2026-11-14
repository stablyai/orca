import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { fileIdentity } from './storage/session-search-file-cursor'
import { sessionSearchReadDecision } from './indexing/session-search-read-decision'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchCatalog } from './session-search-catalog'
import {
  sessionSearchCandidateFacts,
  type SessionSearchFactReference
} from './session-search-candidate-facts'
import type { SessionSearchFileRow } from './storage/session-search-store-types'
import type { SessionSearchStore } from './storage/session-search-store'
import { recordSessionSearchPrimaryFailure } from './session-search-primary-retries'
import type { SessionSearchWorkReceipt } from './session-search-work-queue'
import {
  sessionSearchProjectedCursor,
  type SessionSearchWorkAdmission
} from './session-search-work-admission'
import {
  decodeSessionSearchCurrentWork,
  readSessionSearchCurrentWork,
  readSessionSearchWorkPage
} from './session-search-work-projection'

export type SessionSearchWork = {
  candidate: SessionFileCandidate
  force: boolean
  version: number
  metadata: boolean
  root?: string
  receipt?: SessionSearchWorkReceipt
}

/** Work and selection own independent immutable snapshots, including undiscovered foreground input. */
export class SessionSearchWorkCatalog {
  private version = 0
  private order = 0
  private chooseChanged = true
  private count = 0
  private due = 0
  revision = 0
  constructor(
    private readonly db: SyncDatabase,
    private readonly catalog: SessionSearchCatalog
  ) {
    sessionSearchCandidateFacts(db)
  }
  get eligibleThrough(): number {
    return this.order
  }
  get size(): number {
    return this.count
  }
  get left(): number {
    return this.count - this.due
  }
  private accept<T>(run: () => T): T {
    return this.db.isTransaction ? run() : this.catalog.transaction('search_read_work_accept', run)
  }
  private entry(path: string) {
    return this.db
      .prepare(
        'SELECT path,fact_id,fact_revision,version,force_read,metadata,lane,rank,ordering,due,deferred FROM temp.search_read_work WHERE path=?'
      )
      .get(path)
  }
  private reference(row: Record<string, unknown>): SessionSearchFactReference {
    return { id: Number(row.fact_id), revision: Number(row.fact_revision) }
  }
  enqueue(
    candidate: SessionFileCandidate,
    store: SessionSearchStore,
    force = false,
    recent = true,
    metadata = false,
    accepted?: { projection: SessionSearchWorkAdmission; reference?: SessionSearchFactReference }
  ): void {
    const path = candidate.file.path
    const row = accepted ? accepted.projection.file : store.fileRow(path)
    if (row?.state === 'failed') {
      recordSessionSearchPrimaryFailure(this.catalog, path, true, true)
    }
    if (force) {
      store.catalogCandidates.execute({ kind: 'require', path, reason: 'force' })
    }
    const decision = sessionSearchReadDecision({
      candidate,
      row,
      cursor: accepted
        ? sessionSearchProjectedCursor(candidate, row)
        : row
          ? store.indexedFile(path, fileIdentity(candidate.file))
          : null,
      cutoffMs: store.retentionCutoff
    })
    if (!force && !metadata && decision === 'skip') {
      return
    }
    this.accept(() => {
      const existing = accepted ? accepted.projection.work : this.entry(path)
      const facts = sessionSearchCandidateFacts(this.db)
      const previous = existing && this.reference(existing)
      const selected = accepted?.reference ?? facts.selected(path, candidate.agent)
      const reference = facts.acquire(
        candidate,
        [previous, selected].filter((fact) => fact !== undefined),
        accepted?.reference ? { reference: accepted.reference, candidate } : undefined
      )
      const due = row?.state === 'due'
      this.db
        .prepare(`INSERT INTO temp.search_read_work
        (path,fact_id,fact_revision,version,force_read,metadata,lane,rank,ordering,due,deferred)
        VALUES (?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(path) DO UPDATE SET
        fact_id=excluded.fact_id,fact_revision=excluded.fact_revision,version=excluded.version,
        force_read=excluded.force_read,metadata=excluded.metadata,rank=excluded.rank,due=excluded.due,deferred=0`)
        .run(
          path,
          reference.id,
          reference.revision,
          ++this.version,
          Number(force || existing?.force_read === 1),
          Number(metadata || existing?.metadata === 1),
          String(existing?.lane ?? (recent ? 'changed' : 'backlog')),
          -(candidate.file.aliasMtimeMs ?? candidate.file.mtimeMs),
          Number(existing?.ordering ?? ++this.order),
          Number(due)
        )
      this.revision++
      this.count += Number(!existing)
      this.due += Number(due) - Number(existing?.due === 1)
      facts.reclaim(previous)
    })
  }
  insertAccepted(
    rows: {
      candidate: SessionFileCandidate
      reference: SessionSearchFactReference
      due: boolean
      metadata: boolean
    }[],
    recent: boolean
  ): void {
    if (!rows.length) {
      return
    }
    const values = rows.map(({ candidate, reference, due, metadata }) => [
      candidate.file.path,
      reference.id,
      reference.revision,
      ++this.version,
      Number(metadata),
      recent ? 'changed' : 'backlog',
      -(candidate.file.aliasMtimeMs ?? candidate.file.mtimeMs),
      ++this.order,
      Number(due)
    ])
    this.db
      .prepare(`INSERT INTO temp.search_read_work
      (path,fact_id,fact_revision,version,metadata,lane,rank,ordering,due,force_read,deferred)
      SELECT ${values[0].map((_, index) => `json_extract(value,'$[${index}]')`).join(',')},0,0 FROM json_each(?)`)
      .run(JSON.stringify(values))
    this.revision += rows.length
    this.count += rows.length
    this.due += rows.filter((row) => row.due).length
  }
  async hasPublicationDebt(path: string): Promise<boolean> {
    const work = this.get(path)
    return !!work && (work.force || work.metadata)
  }
  next(eligibleThrough = this.order): SessionSearchWork[] {
    return readSessionSearchWorkPage(this.db, eligibleThrough, this.chooseChanged)
  }
  get(path: string, receipt?: SessionSearchWorkReceipt): SessionSearchWork | undefined {
    const row = readSessionSearchCurrentWork(this.db, path)
    return row && (!receipt || this.matchesEntry({ version: receipt.version, receipt }, row))
      ? decodeSessionSearchCurrentWork(row)
      : undefined
  }
  async acknowledge(work: SessionSearchWork, retry: boolean): Promise<void> {
    this.acknowledgeAccepted(work, retry)
  }
  matches(work: SessionSearchWork): boolean {
    const entry = this.entry(work.candidate.file.path)
    return !!entry && this.matchesEntry(work, entry)
  }
  private matchesEntry(
    work: Pick<SessionSearchWork, 'version' | 'receipt'>,
    entry: Record<string, unknown>
  ): boolean {
    const receipt = work.receipt
    return (
      Number(entry.version) === work.version &&
      (!receipt ||
        (receipt.path === entry.path &&
          receipt.version === work.version &&
          receipt.fact === Number(entry.fact_id) &&
          receipt.factRevision === Number(entry.fact_revision) &&
          receipt.ordering === Number(entry.ordering) &&
          receipt.deferred === (entry.deferred === 1)))
    )
  }
  acknowledgeAccepted(work: SessionSearchWork, retry: boolean): void {
    this.acknowledgeCurrent(work, () => ({ force: work.force, retry }))
  }
  acknowledgeCurrent(
    work: SessionSearchWork,
    decide: () => { force: boolean; retry: boolean; due?: boolean }
  ): boolean {
    return this.accept(() => {
      const path = work.candidate.file.path
      const entry = this.entry(path)
      if (!entry || !this.matchesEntry(work, entry)) {
        return false
      }
      sessionSearchCandidateFacts(this.db).verify(this.reference(entry))
      const decision = decide()
      this.chooseChanged = !this.chooseChanged
      if (decision.retry) {
        const order = ++this.order
        const due = !!decision.due
        this.db
          .prepare(
            `UPDATE temp.search_read_work SET force_read=?,metadata=?,lane='backlog',ordering=?,rank=?,due=?,deferred=1 WHERE path=? AND version=?`
          )
          .run(
            Number(decision.force),
            Number(work.metadata),
            order,
            order,
            Number(due),
            path,
            work.version
          )
        this.due += Number(due) - Number(entry.due === 1)
      } else {
        this.removeEntry(entry, false)
      }
      return true
    })
  }
  async remove(path: string, invalidate = true): Promise<void> {
    this.accept(() => this.removeNow(path, invalidate))
  }
  private removeNow(path: string, invalidate: boolean): void {
    const entry = this.entry(path)
    if (!entry) {
      return
    }
    this.removeEntry(entry, invalidate)
  }
  private removeEntry(entry: Record<string, unknown>, invalidate: boolean): void {
    this.db.prepare('DELETE FROM temp.search_read_work WHERE path=?').run(String(entry.path))
    this.revision += Number(invalidate)
    this.count--
    this.due -= Number(entry.due === 1)
    sessionSearchCandidateFacts(this.db).reclaim(this.reference(entry))
  }
  rollbackPoint(): () => void {
    const count = this.count,
      due = this.due,
      revision = this.revision,
      chooseChanged = this.chooseChanged
    return () => {
      this.count = count
      this.due = due
      this.revision = revision
      this.chooseChanged = chooseChanged
    }
  }
  removeAccepted(path: string): void {
    this.accept(() => this.removeNow(path, true))
  }
  async rowChanged(path: string, row: SessionSearchFileRow | undefined): Promise<void> {
    this.rowChangedAccepted(path, row)
  }
  rowChangedAccepted(path: string, row: SessionSearchFileRow | undefined): void {
    this.accept(() => {
      const entry = this.entry(path)
      const due = row?.state === 'due'
      if (!entry || (entry.due === 1) === due) {
        return
      }
      this.db.prepare('UPDATE temp.search_read_work SET due=? WHERE path=?').run(Number(due), path)
      this.due += Number(due) - Number(entry.due === 1)
    })
  }
}
