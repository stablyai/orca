import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type SyncDatabase from '../sqlite/sync-database'
import { reportSessionSearchBackgroundError, traceSessionSearch } from './session-search-trace'

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
          const ids = traceSessionSearch('purge', () => {
            this.db.exec('BEGIN IMMEDIATE')
            try {
              const batch = this.db
                .prepare(
                  "SELECT id FROM messages WHERE id > ? AND role = 'tool' ORDER BY id LIMIT 256"
                )
                .all(cursor)
              if (!batch.length) {
                this.db.exec('COMMIT')
                return batch
              }
              const full = this.db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
              const message = this.db.prepare('DELETE FROM messages WHERE id = ?')
              for (const { id } of batch) {
                full.run(id)
                message.run(id)
              }
              this.db.exec(`INSERT INTO meta(key, value) VALUES ('index_generation', '1')
                ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`)
              this.db.exec('COMMIT')
              return batch
            } catch (error) {
              this.db.exec('ROLLBACK')
              throw error
            }
          })
          if (!ids.length) {
            break
          }
          this.onMessagesChanged(-ids.length)
          cursor = Number(ids.at(-1)!.id)
          changed = true
          await yieldToEventLoop()
        }
        // Why: empty sweeps need no compaction; each vacuum step yields to incoming writes.
        if (changed && !this.closed()) {
          let free = Number(this.db.pragma('freelist_count', { simple: true }))
          while (free > 0 && !this.closed()) {
            traceSessionSearch('vacuum', () => this.db.pragma('incremental_vacuum(2000)'))
            const remaining = Number(this.db.pragma('freelist_count', { simple: true }))
            await yieldToEventLoop()
            if (remaining >= free) {
              break
            }
            free = remaining
          }
          if (!this.closed()) {
            traceSessionSearch('optimize', () =>
              this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('optimize')")
            )
          }
        }
      }
    } catch (error) {
      if (!this.closed()) {
        reportSessionSearchBackgroundError(this.onError, error)
      }
    }
  }
}
