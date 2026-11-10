import { SessionSearchCatalogClient } from './session-search-catalog-client'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { fileIdentity } from './session-search-file-cursor'
import { sessionSearchReadDecision } from './session-search-read-decision'
import type { SessionSearchFileRow, SessionSearchIndexStore } from './session-search-store'

export type SessionSearchWork = {
  candidate: SessionFileCandidate
  force: boolean
  version: number
  metadata: boolean
}
type Queued = { work: SessionSearchWork; lane: string; order: number; due: boolean; rank: number }

/** A unique path's obligation lives in the writer even after it leaves the recent list. */
export class SessionSearchWorkCatalog {
  private catalog: SessionSearchCatalogClient<Queued> | undefined
  private version = 0
  private order = 0
  private chooseChanged = true
  private count = 0
  private due = 0

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
      rank: -(candidate.file.aliasMtimeMs ?? candidate.file.mtimeMs)
    }
    await this.put(path, value)
    this.count += existing ? 0 : 1
    this.due += Number(value.due) - Number(existing?.due ?? false)
  }

  async hasPublicationDebt(path: string): Promise<boolean> {
    const work = await this.get(path)
    return !!work && (work.force || work.metadata)
  }

  async next(): Promise<SessionSearchWork | undefined> {
    const preferred = this.chooseChanged ? 'changed' : 'backlog'
    this.chooseChanged = !this.chooseChanged
    for (const lane of [preferred, preferred === 'changed' ? 'backlog' : 'changed']) {
      const page = await this.catalog!.page({ group: lane, orderRank: true, limit: 1 })
      if (page.rows.length) {
        return page.rows[0].value.work
      }
    }
    return undefined
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
    if (retry) {
      await this.put(path, {
        ...entry,
        work,
        lane: 'backlog',
        order: ++this.order,
        due: false,
        rank: this.order
      })
      this.due -= Number(entry.due)
    } else {
      await this.remove(path)
    }
  }

  async remove(path: string): Promise<void> {
    const entry = await this.catalog?.get(path)
    if (!entry) {
      return
    }
    await this.catalog!.delete(path)
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
    return this.catalog!.put(path, value, { group: value.lane, rank: value.rank, tie: value.order })
  }
}
