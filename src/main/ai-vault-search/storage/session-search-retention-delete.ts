import { reportSessionSearchBackgroundError, traceSessionSearch } from '../session-search-trace'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type SyncDatabase from '../../sqlite/sync-database'
import { deleteSearchMessages } from './session-search-message-rows'
import { readIndexGeneration, recordIndexMaintenance } from './session-search-index-generation'

export const RETENTION_DELETE_ROWS_PER_STEP = 256
// Reclaim freed pages incrementally to avoid a long vacuum after the purge.
const RECLAIM_PAGES_PER_STEP = 2000
// FTS merges free pages constantly and later writes reuse them; moving them each drain only churns the file.
const RECLAIM_FREE_PAGE_SHARE = 0.25

type ExpiredFile = { path: string; mtime_ms: number; row_id: number }

function expiredFilePage(db: SyncDatabase, cutoffMs: number, after?: ExpiredFile): ExpiredFile[] {
  if (!after) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: files defines path/mtime_ms; rowid is SQLite's numeric row key.
    return db
      .prepare(
        `SELECT path,mtime_ms,rowid AS row_id FROM files WHERE mtime_ms < ?
         ORDER BY mtime_ms,rowid LIMIT ?`
      )
      .all(cutoffMs, RETENTION_DELETE_ROWS_PER_STEP) as ExpiredFile[]
  }
  // Split ties so SQLite seeks by both index keys instead of filtering the equal-time prefix.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This projection reads the same schema-defined columns as the first page.
  const page = db
    .prepare(
      `SELECT path,mtime_ms,rowid AS row_id FROM files WHERE mtime_ms = ? AND rowid > ?
       ORDER BY rowid LIMIT ?`
    )
    .all(after.mtime_ms, after.row_id, RETENTION_DELETE_ROWS_PER_STEP) as ExpiredFile[]
  if (page.length < RETENTION_DELETE_ROWS_PER_STEP) {
    page.push(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This projection reads the same schema-defined columns as the first page.
      ...(db
        .prepare(
          `SELECT path,mtime_ms,rowid AS row_id FROM files WHERE mtime_ms > ? AND mtime_ms < ?
           ORDER BY mtime_ms,rowid LIMIT ?`
        )
        .all(
          after.mtime_ms,
          cutoffMs,
          RETENTION_DELETE_ROWS_PER_STEP - page.length
        ) as ExpiredFile[])
    )
  }
  return page
}

/** Hide expired sessions atomically, then reclaim their unreachable messages in bounded transactions. */
export async function deleteExpiredSearchFiles(
  db: SyncDatabase,
  cutoffMs: number | null,
  closed: () => boolean,
  yieldStep: () => Promise<void> = yieldToEventLoop,
  onMessagesChanged: (delta: number) => void = () => undefined,
  reclaim = true
): Promise<void> {
  if (cutoffMs !== null) {
    let after: ExpiredFile | undefined
    while (!closed()) {
      const expired = expiredFilePage(db, cutoffMs, after)
      if (!expired.length) {
        break
      }
      after = expired.at(-1)
      for (const { path } of expired) {
        if (closed()) {
          return
        }
        db.exec('BEGIN IMMEDIATE')
        try {
          // Recheck expiry under the write lock in case a read refreshed this file after the initial scan.
          const file = db
            .prepare('SELECT session_row_id FROM files WHERE path = ? AND mtime_ms < ?')
            .get(path, cutoffMs) as { session_row_id: number | null } | undefined
          if (file) {
            db.prepare('DELETE FROM sessions WHERE id = ?').run(file.session_row_id)
            db.prepare('DELETE FROM files WHERE path = ?').run(path)
          }
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
        await yieldStep()
      }
    }
  }
  if (reclaim) {
    await drainOrphanedMessages(db, closed, yieldStep, onMessagesChanged)
  }
}

/** Drain orphaned rows left by retention, replacement, or interruption; the rows record unfinished work. */
export async function drainOrphanedMessages(
  db: SyncDatabase,
  closed: () => boolean,
  yieldStep: () => Promise<void> = yieldToEventLoop,
  onMessagesChanged: (delta: number) => void = () => undefined
): Promise<void> {
  let after = 0
  let visited = 0
  while (!closed()) {
    // MIN seeks to one owner key, skipping all of a live conversation's message entries.
    const owner = db
      .prepare('SELECT MIN(session_row_id) AS id FROM messages WHERE session_row_id > ?')
      .get(after)?.id
    if (owner === null || owner === undefined) {
      break
    }
    after = Number(owner)
    if (!db.prepare('SELECT id FROM sessions WHERE id = ?').get(after)) {
      await drainOrphanedSessionMessages(db, after, closed, yieldStep, onMessagesChanged)
      visited = 0
    } else if (++visited === RETENTION_DELETE_ROWS_PER_STEP) {
      await yieldStep()
      visited = 0
    }
  }
  // removeFile may free pages even when this drain has no orphaned messages.
  if (!closed()) {
    reclaimFreePages(db)
  }
}

/** The missing parent is durable recovery state; normal writers never reuse its AUTOINCREMENT ID. */
export async function drainOrphanedSessionMessages(
  db: SyncDatabase,
  sessionRowId: number,
  closed: () => boolean,
  yieldStep: () => Promise<void> = yieldToEventLoop,
  onMessagesChanged: (delta: number) => void = () => undefined
): Promise<void> {
  let deleted = RETENTION_DELETE_ROWS_PER_STEP
  while (deleted === RETENTION_DELETE_ROWS_PER_STEP && !closed()) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const before = readIndexGeneration(db)
      deleted = traceSessionSearch('drain', () =>
        deleteSearchMessages(db, sessionRowId, RETENTION_DELETE_ROWS_PER_STEP)
      )
      recordIndexMaintenance(db, before)
      db.exec('COMMIT')
      onMessagesChanged(-deleted)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    reclaimFreePages(db)
    await yieldStep()
  }
}

function reclaimFreePages(db: SyncDatabase): void {
  const free = Number(db.pragma('freelist_count', { simple: true }))
  if (free > Number(db.pragma('page_count', { simple: true })) * RECLAIM_FREE_PAGE_SHARE) {
    traceSessionSearch('vacuum', () => db.pragma(`incremental_vacuum(${RECLAIM_PAGES_PER_STEP})`))
  }
}

/** Owns targeted reclamation; missing parents remain the durable recovery record. */
export class SessionSearchOrphanCleanup {
  private draining = false
  private recoveryRequested = false
  private readonly orphanedSessions = new Set<number>()

  constructor(
    private readonly db: SyncDatabase,
    private readonly closed: () => boolean,
    private readonly onMessagesChanged: (delta: number) => void,
    private readonly onError: (error: unknown) => void
  ) {}

  request(sessionRowId?: number): void {
    if (this.closed()) {
      return
    }
    if (sessionRowId === undefined) {
      this.recoveryRequested = true
    } else {
      this.orphanedSessions.add(sessionRowId)
    }
    if (this.draining) {
      return
    }
    this.draining = true
    void this.runOrphanDrain()
  }

  private async drainKnownOrphans(): Promise<void> {
    // A finite snapshot lets recovery advance even when replacements keep arriving.
    for (const sessionRowId of Array.from(this.orphanedSessions)) {
      if (this.closed()) {
        return
      }
      this.orphanedSessions.delete(sessionRowId)
      await drainOrphanedSessionMessages(
        this.db,
        sessionRowId,
        () => this.closed(),
        undefined,
        this.onMessagesChanged
      )
    }
  }

  private async runOrphanDrain(): Promise<void> {
    try {
      // A microtask would still run cleanup before the awaiting writer/open reply.
      await yieldToEventLoop()
      while (!this.closed() && (this.recoveryRequested || this.orphanedSessions.size > 0)) {
        await this.drainKnownOrphans()
        if (this.recoveryRequested && !this.closed()) {
          this.recoveryRequested = false
          await drainOrphanedMessages(
            this.db,
            () => this.closed(),
            async () => {
              await yieldToEventLoop()
              await this.drainKnownOrphans()
            },
            this.onMessagesChanged
          )
        }
      }
    } catch (error) {
      if (!this.closed()) {
        reportSessionSearchBackgroundError(this.onError, error)
      }
    } finally {
      this.draining = false
    }
  }

  close(): void {
    this.orphanedSessions.clear()
  }
}
