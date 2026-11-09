import { readIndexGeneration, recordIndexMaintenance } from './session-search-index-generation'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type SyncDatabase from '../sqlite/sync-database'
import type { SqliteRow } from '../sqlite/sqlite-statement'
import { reportSessionSearchBackgroundError, traceSessionSearch } from './session-search-trace'

/** Seek over gaps, then examine at most 256 rowids, including conversation rows in the bound. */
export function readSessionSearchToolPurgePage(db: SyncDatabase, after: number) {
  const first = db.prepare('SELECT id FROM messages WHERE id > ? ORDER BY id LIMIT 1').get(after)
  if (!first) {
    return null
  }
  const cursor = Number(first.id) + 255
  const ids = db
    .prepare("SELECT id FROM messages WHERE id > ? AND id <= ? AND role = 'tool' ORDER BY id")
    .all(Number(first.id) - 1, cursor)
  return { cursor, ids }
}

/** The rows themselves record unfinished work; no persisted migration cursor is needed. */
export class SessionSearchToolPurge {
  private requested = false
  private running: Promise<void> | null = null

  constructor(
    private readonly db: SyncDatabase,
    private readonly closed: () => boolean,
    private readonly onMessagesChanged: (delta: number) => void,
    private readonly onError: (error: unknown) => void
  ) {}

  request(): Promise<void> {
    this.requested = true
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null
      })
    }
    return this.running
  }

  private async run(): Promise<void> {
    try {
      // Why: opening the writer and publishing its snapshot must not wait for maintenance.
      await yieldToEventLoop()
      while (this.requested && !this.closed()) {
        this.requested = false
        let cursor = 0
        let changed = false
        while (!this.closed()) {
          // Why: sparse/empty pages must yield too, without acquiring the write lock to scan.
          const page = readSessionSearchToolPurgePage(this.db, cursor)
          if (!page) {
            break
          }
          if (page.ids.length) {
            const deleted = traceSessionSearch('purge', () => this.deletePage(page.ids))
            this.onMessagesChanged(-deleted)
            changed ||= deleted > 0
          }
          cursor = page.cursor
          await yieldToEventLoop()
        }
        if (changed && !this.closed()) {
          await this.compact()
        }
      }
    } catch (error) {
      if (!this.closed()) {
        reportSessionSearchBackgroundError(this.onError, error)
      }
    }
  }

  private deletePage(ids: SqliteRow[]): number {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const before = readIndexGeneration(this.db)
      const full = this.db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
      const message = this.db.prepare("DELETE FROM messages WHERE id = ? AND role = 'tool'")
      let deleted = 0
      for (const { id } of ids) {
        // A foreign writer may have replaced a row after the deferred scan.
        if (message.run(Number(id)).changes) {
          full.run(Number(id))
          deleted++
        }
      }
      if (deleted) {
        this.db.exec(`INSERT INTO meta(key, value) VALUES ('index_generation', '1')
          ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`)
      }
      recordIndexMaintenance(this.db, before)
      this.db.exec('COMMIT')
      return deleted
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private async compact(): Promise<void> {
    const changes = this.db.prepare('SELECT total_changes() AS n')
    const merge = this.db.prepare("INSERT INTO messages_fts(messages_fts, rank) VALUES('merge', ?)")
    // Why: negative starts a two-segment merge; positive steps continue it within the page budget.
    let pages = -64
    while (!this.closed()) {
      const before = Number(changes.get()!.n)
      traceSessionSearch('merge', () => merge.run(pages))
      const done = Number(changes.get()!.n) - before < 2
      await yieldToEventLoop()
      if (done) {
        break
      }
      pages = 64
    }
    // Reclaim pages freed by merging only after the final merge step has yielded.
    let free = this.closed() ? 0 : Number(this.db.pragma('freelist_count', { simple: true }))
    while (free > 0 && !this.closed()) {
      traceSessionSearch('vacuum', () => this.db.pragma('incremental_vacuum(2000)'))
      const remaining = Number(this.db.pragma('freelist_count', { simple: true }))
      await yieldToEventLoop()
      if (remaining >= free) {
        break
      }
      free = remaining
    }
  }
}
