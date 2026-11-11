import { SessionSearchCatalogClient } from './session-search-catalog-client'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { fileIdentity } from './session-search-file-cursor'
import { sessionSearchReadDecision } from './session-search-read-decision'
import type SyncDatabase from '../sqlite/sync-database'
import { sessionSearchCatalogPageRows } from './session-search-catalog-query'
import { SESSION_SEARCH_CATALOG_PAGE_BYTES } from './session-search-catalog'
import type { SessionSearchFileRow, SessionSearchIndexStore } from './session-search-store'

export type SessionSearchWork = {
  candidate: SessionFileCandidate
  force: boolean
  version: number
  metadata: boolean
}
type Queued = {
  work: SessionSearchWork
  lane: string
  order: number
  due: boolean
  rank: number
  deferred: boolean
}

/** A unique path's obligation lives in the writer even after it leaves the recent list. */
export class SessionSearchWorkCatalog {
  private catalog: SessionSearchCatalogClient<Queued> | undefined
  private version = 0
  private order = 0
  private chooseChanged = true
  private count = 0
  private due = 0
  revision = 0
  get eligibleThrough(): number {
    return this.order
  }

  attach(store: SessionSearchIndexStore): void {
    this.catalog ??= new SessionSearchCatalogClient('read-work', (command) =>
      store.catalog(command)
    )
  }
  get size(): number {
    return this.count
  }
  get left(): number {
    return this.count - this.due
  }

  async enqueue(
    candidate: SessionFileCandidate,
    store: SessionSearchIndexStore,
    force = false,
    recent = true,
    metadata = false
  ): Promise<void> {
    this.attach(store)
    const path = candidate.file.path
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
    const existing = await this.catalog!.get(path)
    const value: Queued = {
      work: {
        candidate,
        force: force || (existing?.work.force ?? false),
        version: ++this.version,
        metadata: metadata || (existing?.work.metadata ?? false)
      },
      lane: existing?.lane ?? (recent ? 'changed' : 'backlog'),
      order: existing?.order ?? ++this.order,
      due: row?.state === 'due',
      deferred: false,
      rank: -(candidate.file.aliasMtimeMs ?? candidate.file.mtimeMs)
    }
    await this.put(path, value)
    this.revision++
    this.count += existing ? 0 : 1
    this.due += Number(value.due) - Number(existing?.due ?? false)
  }

  async hasPublicationDebt(path: string): Promise<boolean> {
    const work = await this.get(path)
    return !!work && (work.force || work.metadata)
  }

  next(db: SyncDatabase, eligibleThrough = this.order): SessionSearchWork[] {
    const lanes: ReturnType<typeof sessionSearchCatalogPageRows>[] = []
    const works: SessionSearchWork[] = []
    let bytes = 1024
    let selected = this.chooseChanged ? 0 : 1
    const exhausted = [false, false]
    try {
      for (const lane of ['changed', 'backlog'] as const) {
        lanes.push(
          sessionSearchCatalogPageRows(
            db,
            { kind: 'page', scope: 'read-work', orderRank: true, eligibleThrough, limit: 256 },
            lane
          )
        )
      }
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
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this queue encoded its own catalog record.
        const work = (JSON.parse(String(row.value.value)) as Queued).work
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

  async get(path: string): Promise<SessionSearchWork | undefined> {
    return (await this.catalog?.get(path))?.work
  }

  async acknowledge(work: SessionSearchWork, retry: boolean): Promise<void> {
    const path = work.candidate.file.path
    const entry = await this.catalog!.get(path)
    if (entry?.work.version !== work.version) {
      return
    }
    this.chooseChanged = !this.chooseChanged
    if (retry) {
      await this.put(path, {
        ...entry,
        work,
        lane: 'backlog',
        order: ++this.order,
        due: false,
        deferred: true,
        rank: this.order
      })
      this.due -= Number(entry.due)
    } else {
      await this.remove(path, false)
    }
  }

  async remove(path: string, invalidate = true): Promise<void> {
    const entry = await this.catalog?.get(path)
    if (!entry) {
      return
    }
    await this.catalog!.delete(path)
    this.revision += Number(invalidate)
    this.count--
    this.due -= Number(entry.due)
  }

  async rowChanged(path: string, row: SessionSearchFileRow | undefined): Promise<void> {
    const entry = await this.catalog?.get(path)
    if (!entry || entry.due === (row?.state === 'due')) {
      return
    }
    const due = row?.state === 'due'
    await this.put(path, { ...entry, due })
    this.due += Number(due) - Number(entry.due)
  }

  private put(path: string, value: Queued): Promise<void> {
    return this.catalog!.put(path, value, {
      group: value.lane,
      rank: value.rank,
      tie: value.order,
      ready: Number(!value.deferred)
    })
  }
}
