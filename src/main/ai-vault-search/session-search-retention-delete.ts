import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type SyncDatabase from '../sqlite/sync-database'
import { inSessionParseFileLane } from '../ai-vault/session-parse-file-lane'

export const RETENTION_DELETE_ROWS_PER_STEP = 256

/** A durable tombstone hides partial deletes and lets a reopened store finish them. */
export async function deleteExpiredSearchFiles(
  db: SyncDatabase,
  cutoffMs: number | null,
  closed: () => boolean,
  changed: () => void,
  yieldStep: () => Promise<void> = yieldToEventLoop
): Promise<void> {
  const pending = db.prepare('SELECT path FROM search_pending_deletes').all() as { path: string }[]
  const expired =
    cutoffMs === null
      ? []
      : (db
          .prepare('SELECT path FROM files WHERE mtime_ms < ? ORDER BY mtime_ms')
          .all(cutoffMs) as { path: string }[])
  for (const { path } of [...pending, ...expired]) {
    if (closed()) {
      return
    }
    await inSessionParseFileLane(path, async () => {
      if (closed()) {
        return
      }
      db.exec('BEGIN IMMEDIATE')
      try {
        const file = db
          .prepare(`SELECT session_row_id FROM files WHERE path = ? AND mtime_ms < ?
             AND path NOT IN (SELECT path FROM search_pending_deletes)`)
          .get(path, cutoffMs ?? -Infinity) as { session_row_id: number | null } | undefined
        if (file) {
          if (file.session_row_id !== null) {
            db.prepare(
              'INSERT OR IGNORE INTO search_pending_deletes(path, session_row_id) VALUES (?, ?)'
            ).run(path, file.session_row_id)
          }
          db.prepare('DELETE FROM files WHERE path = ?').run(path)
        }
        db.exec('COMMIT')
        changed()
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      while (!closed()) {
        const pending = db
          .prepare('SELECT session_row_id FROM search_pending_deletes WHERE path = ?')
          .get(path) as { session_row_id: number } | undefined
        if (!pending) {
          return
        }
        db.exec('BEGIN IMMEDIATE')
        try {
          const ids = db
            .prepare('SELECT id FROM messages WHERE session_row_id = ? LIMIT ?')
            .all(pending.session_row_id, RETENTION_DELETE_ROWS_PER_STEP) as { id: number }[]
          const full = db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
          const conversation = db.prepare('DELETE FROM conversation_fts WHERE rowid = ?')
          const message = db.prepare('DELETE FROM messages WHERE id = ?')
          for (const { id } of ids) {
            full.run(id)
            conversation.run(id)
            message.run(id)
          }
          if (ids.length < RETENTION_DELETE_ROWS_PER_STEP) {
            db.prepare('DELETE FROM sessions WHERE id = ?').run(pending.session_row_id)
            db.prepare('DELETE FROM search_pending_deletes WHERE path = ?').run(path)
          }
          db.exec('COMMIT')
          changed()
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
        await yieldStep()
      }
    })
  }
}
