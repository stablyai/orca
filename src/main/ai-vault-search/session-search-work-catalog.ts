import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { fileIdentity } from './storage/session-search-file-cursor'
import { sessionSearchReadDecision } from './indexing/session-search-read-decision'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchCatalog } from './session-search-catalog'
import { SESSION_SEARCH_CATALOG_PAGE_BYTES } from './session-search-catalog'
import {
  sessionSearchCandidateFacts,
  type SessionSearchFactReference
} from './session-search-candidate-facts'
import type { SessionSearchFileRow } from './storage/session-search-store-types'
import type { SessionSearchStore } from './storage/session-search-store'
import { recordSessionSearchPrimaryFailure } from './session-search-primary-retries'

export type SessionSearchWork = {
  candidate: SessionFileCandidate
  force: boolean
  version: number
  metadata: boolean
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
  private project(row: Record<string, unknown>): SessionSearchWork {
    return {
      candidate: sessionSearchCandidateFacts(this.db).get(this.reference(row)),
      version: Number(row.version),
      force: row.force_read === 1,
      metadata: row.metadata === 1
    }
  }
  enqueue(
    candidate: SessionFileCandidate,
    store: SessionSearchStore,
    force = false,
    recent = true,
    metadata = false
  ): void {
    const path = candidate.file.path
    if (store.fileRow(path)?.state === 'failed') {
      recordSessionSearchPrimaryFailure(this.catalog, path, true, true)
    }
    if (force) {
      store.catalogCandidates.execute({ kind: 'require', path, reason: 'force' })
    }
    const row = store.fileRow(path)
    const decision = sessionSearchReadDecision({
      candidate,
      row,
      cursor: row ? store.indexedFile(path, fileIdentity(candidate.file)) : null,
      cutoffMs: store.retentionCutoff
    })
    if (!force && !metadata && decision === 'skip') {
      return
    }
    this.accept(() => {
      const existing = this.entry(path)
      const facts = sessionSearchCandidateFacts(this.db)
      const previous = existing && this.reference(existing)
      const selected = facts.selected(path, candidate.agent)
      const reference = facts.acquire(
        candidate,
        [previous, selected].filter((fact) => fact !== undefined)
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
  async hasPublicationDebt(path: string): Promise<boolean> {
    const work = this.get(path)
    return !!work && (work.force || work.metadata)
  }
  next(eligibleThrough = this.order): SessionSearchWork[] {
    const lanes = (['changed', 'backlog'] as const).map((lane) =>
      this.db
        .prepare(`SELECT path,fact_id,fact_revision,version,force_read,metadata,lane,rank,ordering,due,deferred FROM temp.search_read_work
      WHERE lane='${lane}' AND (deferred=0 OR ordering<=?) ORDER BY rank,ordering,path LIMIT 256`)
        .iterate(eligibleThrough)
    )
    const works: SessionSearchWork[] = []
    let bytes = 1024,
      selected = this.chooseChanged ? 0 : 1
    const exhausted = [false, false]
    try {
      while (works.length < 256) {
        if (exhausted[selected]) {
          selected = 1 - selected
          if (exhausted[selected]) {
            break
          }
        }
        const row = lanes[selected].next()
        if (row.done) {
          exhausted[selected] = true
          continue
        }
        const work = this.project(row.value)
        const size = JSON.stringify(work).length * 2 + 64
        if (works.length && bytes + size > SESSION_SEARCH_CATALOG_PAGE_BYTES) {
          break
        }
        works.push(work)
        bytes += size
        if (bytes >= SESSION_SEARCH_CATALOG_PAGE_BYTES) {
          break
        }
        selected = 1 - selected
      }
    } finally {
      for (const lane of lanes) {
        lane.return?.()
      }
    }
    return works
  }
  get(path: string): SessionSearchWork | undefined {
    const row = this.entry(path)
    return row && this.project(row)
  }
  async acknowledge(work: SessionSearchWork, retry: boolean): Promise<void> {
    this.accept(() => {
      const path = work.candidate.file.path
      const entry = this.entry(path)
      if (!entry || Number(entry.version) !== work.version) {
        return
      }
      this.project(entry)
      this.chooseChanged = !this.chooseChanged
      if (retry) {
        const order = ++this.order
        this.db
          .prepare(
            `UPDATE temp.search_read_work SET force_read=?,metadata=?,lane='backlog',ordering=?,rank=?,due=0,deferred=1 WHERE path=? AND version=?`
          )
          .run(Number(work.force), Number(work.metadata), order, order, path, work.version)
        this.due -= Number(entry.due === 1)
      } else {
        this.removeNow(path, false)
      }
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
    this.db.prepare('DELETE FROM temp.search_read_work WHERE path=?').run(path)
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
