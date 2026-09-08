import { assertSearchWalBudget, SEARCH_WAL_PENDING_BYTES } from './session-search-wal-budget'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type SyncDatabase from '../sqlite/sync-database'
import type {
  SessionSearchCapturedMessage,
  SessionSearchFileIdentity,
  SessionSearchIndexedFile,
  SessionSearchIndexWrite
} from '../ai-vault/session-search-capture'
import { SessionSearchCaptureIncompleteError } from '../ai-vault/session-search-capture'
import { EMPTY_CONTENT_HASH, foldContentHash } from './session-search-content-hash'
import { SessionSearchFileRecords } from './session-search-file-records'
import { insertSearchMessage, searchMessageRows } from './session-search-message-rows'
import { discardSearchBatch, retireSearchSession } from './session-search-pending-deletes'
import { redactSessionSearchText } from './session-search-redaction'
import { sessionSearchPathKey } from './session-search-path-key'
export { chunkMessageText } from './session-search-message-rows'

export const SEARCH_WRITE_ROWS_PER_STEP = 128
export const SEARCH_WRITE_CHARS_PER_STEP = 256 * 1024
// Why sampled: the checkpoint costs more than the step it guards, and the backlog only grows
// while a second connection pins a snapshot — a killed scanner child whose handle outlives the
// replacement fork, not two processes the app runs on purpose.
const WAL_BUDGET_EVERY_STEPS = 16

export type SessionSearchApplyOptions = {
  /** False once this write is superseded; staging stops without publishing. */
  active?: () => boolean
  yieldStep?: () => Promise<void>
  /** False once the database is gone; gates the discard tombstone. Defaults to `active`. */
  available?: () => boolean
}

type ResolvedApplyOptions = Required<SessionSearchApplyOptions>

export type SessionSearchMetadata = Pick<
  AiVaultSession,
  'sessionId' | 'filePath' | 'title' | 'cwd' | 'branch' | 'updatedAt'
>

type FileRow = {
  dev: number | null
  ino: number | null
  byte_offset: number
  mtime_ms: number
  size_bytes: number | null
  session_row_id: number | null
}

export class SessionSearchIndexWriter {
  private readonly records: SessionSearchFileRecords
  private activePath: string | null = null
  private invalidated = false
  private pending: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly db: SyncDatabase,
    private readonly walBudgetBytes: number = SEARCH_WAL_PENDING_BYTES
  ) {
    this.records = new SessionSearchFileRecords(db)
  }
  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null {
    const row = this.db
      .prepare(
        'SELECT dev, ino, byte_offset, mtime_ms, size_bytes, session_row_id FROM files WHERE path = ?'
      )
      .get(path) as FileRow | undefined
    if (!row) {
      return null
    }
    if (identity && row.dev !== null && row.ino !== null) {
      if (row.dev !== identity.dev || row.ino !== identity.ino) {
        return null
      }
    }
    return { byteOffset: row.byte_offset, mtimeMs: row.mtime_ms, sizeBytes: row.size_bytes }
  }

  indexedMetadata(path: string): SessionSearchMetadata | null {
    return (
      (this.db
        .prepare(`SELECT session_id AS sessionId, file_path AS filePath,
      title, cwd, branch, updated_at AS updatedAt FROM sessions
      WHERE id = (SELECT session_row_id FROM files WHERE path = ?)`)
        .get(path) as SessionSearchMetadata | undefined) ?? null
    )
  }

  updateMetadata(path: string, session: SessionSearchMetadata): void {
    this.db
      .prepare(`UPDATE sessions SET title = ?, cwd = ?, cwd_key = ?, branch = ?
      WHERE id = (SELECT session_row_id FROM files WHERE path = ?) AND session_id = ?`)
      .run(
        redactSessionSearchText(session.title),
        session.cwd,
        session.cwd ? sessionSearchPathKey(session.cwd, session.filePath) : null,
        session.branch,
        path,
        session.sessionId
      )
  }

  apply(
    update: SessionSearchIndexWrite,
    options: SessionSearchApplyOptions = {}
  ): Promise<boolean> {
    const active = options.active ?? (() => true)
    const resolved: ResolvedApplyOptions = {
      active,
      yieldStep: options.yieldStep ?? yieldToEventLoop,
      available: options.available ?? active
    }
    const run = this.pending
      .catch(() => undefined)
      .then(async () => {
        this.activePath = update.candidate.file.path
        this.invalidated = false
        try {
          return await this.stage(update, resolved)
        } finally {
          this.activePath = null
        }
      })
    this.pending = run
    return run
  }

  /** Invalidation hides the generation immediately; cleanup does the expensive deletes later. */
  removeFile(path: string): void {
    if (this.activePath === path) {
      this.invalidated = true
    }
    const existing = this.file(path)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (existing?.session_row_id != null) {
        retireSearchSession(this.db, existing.session_row_id)
      }
      this.db.prepare('DELETE FROM files WHERE path = ?').run(path)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private file(path: string): Pick<FileRow, 'session_row_id' | 'byte_offset'> | undefined {
    return this.db
      .prepare('SELECT session_row_id,byte_offset FROM files WHERE path = ?')
      .get(path) as Pick<FileRow, 'session_row_id' | 'byte_offset'> | undefined
  }

  private async stage(
    update: SessionSearchIndexWrite,
    { active, yieldStep, available }: ResolvedApplyOptions
  ): Promise<boolean> {
    if (!active()) {
      return false
    }
    const path = update.candidate.file.path
    const existing = this.file(path)
    const append =
      update.mode === 'append' &&
      existing?.session_row_id != null &&
      existing.byte_offset === update.previousByteOffset
    if (update.mode === 'append' && !append) {
      // A stale producer cannot invalidate a newer published cursor.
      return false
    }
    let hash = append ? this.records.contentHash(existing!.session_row_id!) : EMPTY_CONTENT_HASH
    let sessionId: number
    let batchId: number
    this.db.exec('BEGIN IMMEDIATE')
    try {
      sessionId = append
        ? existing!.session_row_id!
        : this.records.createStagingSession(update.candidate)
      batchId = Number(
        this.db
          .prepare('INSERT INTO search_write_batches(session_row_id) VALUES (?)')
          .run(sessionId).lastInsertRowid
      )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const unchanged = (): boolean => {
      const current = this.file(path)
      return (
        !this.invalidated &&
        current?.session_row_id === existing?.session_row_id &&
        current?.byte_offset === existing?.byte_offset
      )
    }
    try {
      async function* capturedRows() {
        for await (const message of update.messages) {
          hash = foldContentHash(hash, [message])
          yield* searchMessageRows([message])
        }
      }
      const rows = capturedRows()
      let next = await rows.next()
      let step = 0
      while (!next.done) {
        const batch: SessionSearchCapturedMessage[] = []
        let chars = 0
        while (
          !next.done &&
          batch.length < SEARCH_WRITE_ROWS_PER_STEP &&
          chars < SEARCH_WRITE_CHARS_PER_STEP
        ) {
          batch.push(next.value)
          chars += next.value.text.length
          next = await rows.next()
        }
        if (!active() || !unchanged()) {
          await rows.return(undefined)
          return false
        }
        if (step++ % WAL_BUDGET_EVERY_STEPS === 0) {
          assertSearchWalBudget(this.db, this.walBudgetBytes)
        }
        this.db.exec('BEGIN IMMEDIATE')
        try {
          for (const message of batch) {
            insertSearchMessage(this.db, sessionId, batchId, message)
          }
          this.db.exec('COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
        await yieldStep()
      }
      const result = await update.result
      if (!active() || !unchanged()) {
        return false
      }
      this.db.exec('BEGIN IMMEDIATE')
      try {
        if (!result.session) {
          if (existing?.session_row_id != null) {
            retireSearchSession(this.db, existing.session_row_id)
          }
          this.records.upsertFile(update.candidate, result.byteOffset, null)
          this.db.exec('COMMIT')
          return true
        }
        this.records.updateSession(result.session, sessionId, hash)
        if (!append && existing?.session_row_id != null) {
          retireSearchSession(this.db, existing.session_row_id)
        }
        this.db.prepare('UPDATE sessions SET index_ready=1 WHERE id=?').run(sessionId)
        // Clearing the pointer before dropping the batch is what makes a recycled
        // rowid harmless: no published row can name a later in-flight batch.
        this.db.prepare('UPDATE messages SET batch_id=NULL WHERE batch_id=?').run(batchId)
        this.db.prepare('DELETE FROM search_write_batches WHERE id=?').run(batchId)
        this.records.upsertFile(update.candidate, result.byteOffset, sessionId)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      return true
    } catch (error) {
      // Not a write failure: the producer read degraded, so these rows are not
      // the whole file. Refusing the write leaves it non-current and the next
      // scan re-parses it, which is what markStale already means downstream.
      if (error instanceof SessionSearchCaptureIncompleteError) {
        return false
      }
      throw error
    } finally {
      // A surviving batch row means publish never ran, whatever ended the stage.
      if (
        available() &&
        this.db.prepare('SELECT 1 FROM search_write_batches WHERE id=?').get(batchId)
      ) {
        discardSearchBatch(this.db, sessionId, batchId, !append)
      }
    }
  }
}
