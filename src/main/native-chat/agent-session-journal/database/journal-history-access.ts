import type Database from '../../../sqlite/sync-database'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import type { WorkerRequestTransport } from '../../../worker-threads/worker-thread-transport'
import type { JournalHostDatabase } from './journal-host-database'
import { journalHistoryWorkerSource } from './journal-history-worker-source'
import { JournalRecoveryStopSummaries } from './journal-recovery-stop-summaries'

const owners = new WeakMap<Database.Database, JournalHistoryAccess>()
import {
  ensureJournalHistoryTables,
  historySources,
  historyCoverage,
  historySourceKey,
  historyCovers,
  journalHistoryCovered,
  journalHistoryIncarnation,
  ensureHistoryCoverage,
  prepareJournalStopHistory,
  historyIdentity,
  type Source,
  type Page,
  type Demand
} from './journal-history-source'
/** Derived access is optional; the journal and ordinary send never wait for its maintenance. */
export class JournalHistoryAccess {
  readonly summaries = new JournalRecoveryStopSummaries()
  readonly personalStops = this.summaries.values
  private worker: WorkerRequestTransport | undefined
  private readonly demands = new Map<string, Demand[]>()
  private pending: { id: number; source: Source; incarnation: string } | undefined
  private nextId = 0
  private unavailable = false
  private closed = false
  private deadline: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly database: JournalHostDatabase,
    private readonly filename: string
  ) {
    owners.set(database.db, this)
    try {
      ensureJournalHistoryTables(database.db)
    } catch {
      this.unavailable = true
    }
  }

  async prepare(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    return this.prepareSources(sessionId, () => true, signal)
  }

  prepareRequests(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    return this.prepareSources(sessionId, (source) => source.generation !== 0, signal)
  }

  private async prepareSources(
    sessionId: string,
    include: (source: Source) => boolean,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (this.closed || this.unavailable || signal?.aborted) {
      return false
    }
    try {
      const identity = this.sourceIdentity(sessionId, true)
      if (identity === null) {
        return false
      }
      const sources = historySources(this.database.db, sessionId).filter(include)
      const ready = await Promise.all(sources.map((source) => this.demand(source, signal)))
      return ready.every(Boolean) && identity === this.sourceIdentity(sessionId)
    } catch {
      return false
    }
  }

  prepareStops(sessionId: string, signal?: AbortSignal) {
    if (this.closed || this.unavailable || signal?.aborted) {
      return Promise.resolve('unavailable' as const)
    }
    return prepareJournalStopHistory(this.database, sessionId, (source) =>
      this.demand(source, signal)
    )
  }

  sourceIdentity = (sessionId: string, initialize = false) =>
    historyIdentity(this.database, sessionId, initialize)

  retainSessions = (ids: readonly string[]): void => this.summaries.retain(ids)
  pinSessions = (ids: readonly string[]): (() => void) => this.summaries.pin(ids)
  retains = (id: string): boolean => this.summaries.retains(id)

  covered(sessionId: string, epoch: string, generation: number, through: number): boolean {
    return (
      !this.closed &&
      !this.unavailable &&
      journalHistoryCovered(this.database.db, sessionId, epoch, generation, through)
    )
  }

  incarnation(sessionId: string, epoch: string, generation: number): string | null {
    return this.closed || this.unavailable
      ? null
      : journalHistoryIncarnation(this.database.db, sessionId, epoch, generation)
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.deadline)
    this.finishAll(false)
    this.summaries.clear()
    await this.worker?.terminate()
    this.worker = undefined
  }

  private demand(source: Source, signal?: AbortSignal): Promise<boolean> {
    const saved = historyCoverage(this.database.db, source)
    if (saved?.dirty === 0 && historyCovers(source, saved, source.through)) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const key = historySourceKey(source)
      const demand: Demand = {
        source,
        resolve: (ready) => {
          signal?.removeEventListener('abort', abort)
          resolve(ready)
        },
        signal
      }
      const abort = () => {
        const entries = this.demands.get(key)
        if (entries) {
          const remaining = entries.filter((entry) => entry !== demand)
          if (remaining.length) {
            this.demands.set(key, remaining)
          } else {
            this.demands.delete(key)
          }
        }
        demand.resolve(false)
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.demands.set(key, [...(this.demands.get(key) ?? []), demand])
      if (signal?.aborted) {
        abort()
      }
      this.pump()
    })
  }

  private pump(): void {
    if (this.pending || this.closed || this.unavailable) {
      return
    }
    const entry = this.demands.entries().next().value
    if (!entry) {
      return
    }
    const [key, demands] = entry
    const source = demands.reduce(
      (last, demand) => (demand.source.through > last.through ? demand.source : last),
      demands[0]!.source
    )
    try {
      const current = historySources(this.database.db, source.sessionId).find(
        (value) => historySourceKey(value) === key
      )
      if (!current || current.through < source.through) {
        this.finish(key, false)
        queueMicrotask(() => this.pump())
        return
      }
      const saved = ensureHistoryCoverage(this.database, source)
      if (historyCovers(source, saved, source.through)) {
        this.finish(key, true)
        queueMicrotask(() => this.pump())
        return
      }
      if (!this.worker) {
        const worker = spawnWorkerThread(journalHistoryWorkerSource, {
          eval: true,
          workerData: { filename: this.filename }
        })
        this.worker = worker
        worker.on('message', (page: Page) => this.receive(page, worker))
        worker.on('error', () => this.fail(worker))
        worker.on('exit', () => {
          this.fail(worker)
        })
        worker.unref()
      }
      const id = ++this.nextId
      this.pending = { id, source, incarnation: saved.incarnation }
      this.worker.postMessage({
        id,
        ...source,
        after: { seq: saved.seq, field: saved.field, key: saved.key }
      })
      const activeWorker = this.worker
      this.deadline = setTimeout(() => this.fail(activeWorker), 30_000)
      this.deadline.unref?.()
    } catch {
      this.finish(key, false)
      queueMicrotask(() => this.pump())
    }
  }

  private receive(page: Page, worker: WorkerRequestTransport): void {
    const pending = this.pending
    if (!pending || page.id !== pending.id || this.closed || this.worker !== worker) {
      return
    }
    clearTimeout(this.deadline)
    this.pending = undefined
    const { source, incarnation } = pending
    const key = historySourceKey(source)
    if (page.failed) {
      this.finish(key, false)
      this.pump()
      return
    }
    try {
      let published = false
      this.database.transaction((db) => {
        const current = historySources(this.database.db, source.sessionId).find(
          (value) => historySourceKey(value) === key
        )
        const saved = historyCoverage(this.database.db, source)
        if (
          !current ||
          current.through < source.through ||
          !saved ||
          saved.dirty ||
          saved.incarnation !== incarnation
        ) {
          return
        }
        const insert = db.prepare(
          'INSERT OR REPLACE INTO journal_history_locators VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        for (const locator of page.locators) {
          insert.run(
            source.sessionId,
            source.epoch,
            source.generation,
            locator.seq,
            locator.field,
            locator.key,
            locator.kind,
            incarnation
          )
        }
        const after = page.complete
          ? { seq: source.through, field: '\uffff', key: '\uffff' }
          : page.after
        db.prepare(`UPDATE journal_history_coverage SET seq = ?, field = ?, entry_key = ?
          WHERE session_id = ? AND epoch = ? AND generation = ?`).run(
          after.seq,
          after.field,
          after.key,
          source.sessionId,
          source.epoch,
          source.generation
        )
        published = true
      }, true)
      if (!published) {
        this.finish(key, false)
      } else {
        const entries = this.demands.get(key) ?? []
        const covered = page.complete ? source.through : page.after.seq - 1
        const remaining = entries.filter((demand) => {
          if (demand.source.through <= covered) {
            demand.resolve(true)
            return false
          }
          return true
        })
        this.demands.delete(key)
        if (remaining.length) {
          this.demands.set(key, remaining)
        }
      }
    } catch {
      this.finish(key, false)
    }
    // One acknowledged page per source, round-robin; no queued payloads or held read snapshots.
    queueMicrotask(() => this.pump())
  }

  private finish(key: string, ready: boolean): void {
    const demands = this.demands.get(key)
    this.demands.delete(key)
    for (const demand of demands ?? []) {
      demand.resolve(ready)
    }
  }

  private finishAll(ready: boolean): void {
    for (const key of this.demands.keys()) {
      this.finish(key, ready)
    }
  }

  private fail(worker: WorkerRequestTransport): void {
    if (this.worker !== worker || this.closed) {
      return
    }
    clearTimeout(this.deadline)
    this.worker = undefined
    this.pending = undefined
    this.finishAll(false)
    void worker.terminate().catch(() => undefined)
  }
}

export function journalHistoryAccess(db: Database.Database): JournalHistoryAccess | undefined {
  return owners.get(db)
}
