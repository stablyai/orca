import { readIndexGeneration, recordIndexMaintenance } from './session-search-index-generation'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type SyncDatabase from '../sqlite/sync-database'
import type { SqliteRow } from '../sqlite/sqlite-statement'
import { reportSessionSearchBackgroundError, traceSessionSearch } from './session-search-trace'

const SCANNED_KEY = 'tool_purge_scanned_rowid'
const FLOOR_KEY = 'tool_purge_floor_rowid'
export const SESSION_SEARCH_TOOL_PURGE_TRIGGER = 'search_tool_purge_floor'

/** Older builds still index tool rows; any writer's tool insert lowers the next pass's start, even
 * when a rowid below the scanned mark is reused after tail deletes. */
export const SESSION_SEARCH_TOOL_PURGE_SQL = `
CREATE TRIGGER IF NOT EXISTS ${SESSION_SEARCH_TOOL_PURGE_TRIGGER} AFTER INSERT ON messages
WHEN NEW.role = 'tool' BEGIN
  INSERT INTO meta(key, value) VALUES ('${FLOOR_KEY}', NEW.id - 1)
    ON CONFLICT(key) DO UPDATE SET
      value = MIN(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER));
END;
`

function readMetaInteger(db: SyncDatabase, key: string): number | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  const value = row ? Number(row.value) : Number.NaN
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function writeScannedMark(db: SyncDatabase, value: number): void {
  db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(SCANNED_KEY, String(value))
}

/** Fold the trigger's floor into the persisted mark atomically, so a cancelled pass loses nothing. */
export function claimSessionSearchToolPurgeStart(db: SyncDatabase): number {
  if (readMetaInteger(db, FLOOR_KEY) === null) {
    return readMetaInteger(db, SCANNED_KEY) ?? 0
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const scanned = readMetaInteger(db, SCANNED_KEY) ?? 0
    const floor = readMetaInteger(db, FLOOR_KEY)
    const start = floor === null ? scanned : Math.min(scanned, floor)
    writeScannedMark(db, start)
    db.prepare('DELETE FROM meta WHERE key = ?').run(FLOOR_KEY)
    db.exec('COMMIT')
    return start
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

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

/** A persisted high-water rowid bounds steady-state passes to rows written since the last one. */
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
        const start = claimSessionSearchToolPurgeStart(this.db)
        let cursor = start
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
        // Why: tool rows inserted mid-pass re-create the floor, so overwriting the mark loses none.
        if (cursor > start && !this.closed()) {
          writeScannedMark(this.db, cursor)
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
