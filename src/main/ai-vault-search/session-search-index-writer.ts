import type SyncDatabase from '../sqlite/sync-database'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type {
  TranscriptMessage,
  TranscriptReadOutcome
} from '../ai-vault/session-transcript-consumers'
import { EMPTY_CONTENT_HASH, foldContentHash } from './session-search-content-hash'
import type {
  SessionSearchFileIdentity,
  SessionSearchIndexedFile
} from './session-search-file-cursor'
import { SessionSearchFileRecords } from './session-search-file-records'
import { insertSearchMessage, searchMessageRows } from './session-search-message-rows'
import { discardSearchBatch, retireSearchSession } from './session-search-pending-deletes'
import { assertSearchWalBudget, SEARCH_WAL_PENDING_BYTES } from './session-search-wal-budget'

// Why bounded rather than streamed: the transcript reader pushes messages
// synchronously, so a staged write cannot make the producer wait. Rows are
// buffered to one of these two ceilings and then written in a single
// transaction, which caps both the retained bytes and the length of one stall.
export const SEARCH_WRITE_ROWS_PER_STEP = 128
export const SEARCH_WRITE_CHARS_PER_STEP = 256 * 1024
// Why sampled: the checkpoint costs more than the step it guards, and the backlog only grows
// while a second connection pins a snapshot — a killed scanner child whose handle outlives the
// replacement fork, not two processes the app runs on purpose.
const WAL_BUDGET_EVERY_STEPS = 16

type FileRow = {
  dev: number | null
  ino: number | null
  byte_offset: number
  mtime_ms: number
  size_bytes: number | null
  session_row_id: number | null
}

type ExistingFile = Pick<FileRow, 'session_row_id' | 'byte_offset'>

export type SessionSearchStagedWrite = {
  /** Buffers one message, flushing a full batch into the staging area. */
  add(message: TranscriptMessage): void
  /**
   * Makes every staged row visible in one transaction, or drops the file's rows
   * when the read decoded no session. False when the file was invalidated or
   * its published cursor moved while this write was staging.
   */
  publish(outcome: TranscriptReadOutcome): boolean
  /** Tombstones whatever is still staged; safe after `publish` and after a failure. */
  discard(): void
}

export class SessionSearchIndexWriter {
  private readonly records: SessionSearchFileRecords
  // One open stage per path. Reads of one transcript are serialized by the parse
  // file lane, so this only ever tracks the read in flight; `removeFile` can
  // therefore invalidate the open stage by path. If the lane is ever bypassed,
  // the later stage takes the slot and the earlier one loses its invalidation
  // hook, but it still cannot publish: `publishable` re-reads the cursor and
  // refuses. Both halves are pinned in session-search-index-writer.test.ts.
  private readonly staging = new Map<string, { invalidated: boolean }>()

  constructor(
    private readonly db: SyncDatabase,
    private readonly walBudgetBytes: number = SEARCH_WAL_PENDING_BYTES
  ) {
    this.records = new SessionSearchFileRecords(db)
  }

  /** Tests only: an entry surviving a finished read leaks for the store's life. */
  get openStageCount(): number {
    return this.staging.size
  }

  /** This index's own cursor, or null when the file is unknown or its identity changed. */
  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null {
    const row = this.db
      .prepare(
        'SELECT dev, ino, byte_offset, mtime_ms, size_bytes, session_row_id FROM files WHERE path = ?'
      )
      .get(path) as FileRow | undefined
    if (!row) {
      return null
    }
    // A recorded identity that no longer matches is a different file at the same
    // path; the rows describe the old one.
    //
    // Half an identity is no identity: `remote-session-file-stat` spreads dev and
    // ino independently, so a host can record one without the other, and the
    // COALESCE in `upsertFile` now preserves that half across a later read. One
    // number cannot tell a rename-replace from a same-file re-read, so comparing
    // it would decline healthy resumes on the strength of a coincidence, and
    // `fileIdentity` refuses to build a half identity for the same reason.
    if (identity && row.dev !== null && row.ino !== null) {
      if (row.dev !== identity.dev || row.ino !== identity.ino) {
        return null
      }
    }
    return { byteOffset: row.byte_offset, mtimeMs: row.mtime_ms, sizeBytes: row.size_bytes }
  }

  /**
   * Opens a staging batch for one read, or returns null when the read cannot
   * extend what is published: an `append` whose predecessor byte offset is not
   * this index's own cursor covers a span the index never saw.
   */
  beginWrite(
    candidate: SessionFileCandidate,
    mode: 'replace' | 'append',
    previousByteOffset: number
  ): SessionSearchStagedWrite | null {
    const path = candidate.file.path
    const existing = this.file(path)
    if (mode === 'append' && existing?.byte_offset !== previousByteOffset) {
      return null
    }
    // A file the index read through and decoded no session from still has a
    // cursor worth continuing: it has no session row to hang new rows off, so
    // this read makes one. Declining instead would force a whole re-read of
    // that file on every pass for as long as it grows.
    return this.stage(
      candidate,
      existing,
      mode === 'append' ? (existing?.session_row_id ?? null) : null
    )
  }

  /** Invalidation hides the generation immediately; cleanup does the expensive deletes later. */
  removeFile(path: string): void {
    const open = this.staging.get(path)
    if (open) {
      open.invalidated = true
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

  private file(path: string): ExistingFile | undefined {
    return this.db
      .prepare('SELECT session_row_id,byte_offset FROM files WHERE path = ?')
      .get(path) as ExistingFile | undefined
  }

  /** `resumed` is the session row this read continues, or null when it starts one. */
  private stage(
    candidate: SessionFileCandidate,
    existing: ExistingFile | undefined,
    resumed: number | null
  ): SessionSearchStagedWrite {
    const db = this.db
    const path = candidate.file.path
    let hash = resumed === null ? EMPTY_CONTENT_HASH : this.records.contentHash(resumed)
    let sessionId: number
    let batchId: number
    db.exec('BEGIN IMMEDIATE')
    try {
      sessionId = resumed ?? this.records.createStagingSession(candidate)
      batchId = Number(
        db.prepare('INSERT INTO search_write_batches(session_row_id) VALUES (?)').run(sessionId)
          .lastInsertRowid
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }

    const open = { invalidated: false }
    this.staging.set(path, open)
    const buffer: TranscriptMessage[] = []
    let bufferedChars = 0
    let steps = 0

    // A writer that published its own batch for this path moved the cursor these
    // staged rows continue from; publishing on top would duplicate or skip a span.
    const publishable = (): boolean => {
      if (open.invalidated) {
        return false
      }
      const current = this.file(path)
      return (
        current?.session_row_id === existing?.session_row_id &&
        current?.byte_offset === existing?.byte_offset
      )
    }

    const flush = (): void => {
      if (buffer.length === 0) {
        return
      }
      if (steps++ % WAL_BUDGET_EVERY_STEPS === 0) {
        assertSearchWalBudget(db, this.walBudgetBytes)
      }
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const row of buffer) {
          insertSearchMessage(db, sessionId, batchId, row)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      buffer.length = 0
      bufferedChars = 0
    }

    const close = (): void => {
      if (this.staging.get(path) === open) {
        this.staging.delete(path)
      }
    }

    return {
      add: (message) => {
        if (open.invalidated) {
          return
        }
        hash = foldContentHash(hash, [message])
        for (const row of searchMessageRows([message])) {
          buffer.push(row)
          bufferedChars += row.text.length
          if (
            buffer.length >= SEARCH_WRITE_ROWS_PER_STEP ||
            bufferedChars >= SEARCH_WRITE_CHARS_PER_STEP
          ) {
            flush()
          }
        }
      },
      publish: (outcome) => {
        if (!publishable()) {
          return false
        }
        flush()
        db.exec('BEGIN IMMEDIATE')
        try {
          if (outcome.session) {
            this.records.updateSession(outcome.session, sessionId, hash)
            if (resumed === null && existing?.session_row_id != null) {
              retireSearchSession(db, existing.session_row_id)
            }
            db.prepare('UPDATE sessions SET index_ready=1 WHERE id=?').run(sessionId)
            // Clearing the pointer before dropping the batch is what makes a recycled
            // rowid harmless: no published row can name a later in-flight batch.
            db.prepare('UPDATE messages SET batch_id=NULL WHERE batch_id=?').run(batchId)
            db.prepare('DELETE FROM search_write_batches WHERE id=?').run(batchId)
            this.records.upsertFile(candidate, outcome.byteOffset, sessionId)
          } else {
            // No session: the file is read through but holds nothing to search,
            // so the cursor advances and the old generation's rows are retired.
            // `discard` then tombstones this write's own staging rows.
            if (existing?.session_row_id != null) {
              retireSearchSession(db, existing.session_row_id)
            }
            this.records.upsertFile(candidate, outcome.byteOffset, null)
          }
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
        return true
      },
      discard: () => {
        buffer.length = 0
        close()
        // A surviving batch row means publish never made these rows visible,
        // whatever ended the stage.
        if (db.prepare('SELECT 1 FROM search_write_batches WHERE id=?').get(batchId)) {
          // Owning the session means this read created it, so retiring it takes
          // the whole staging generation with it.
          discardSearchBatch(db, sessionId, batchId, resumed === null)
        }
      }
    }
  }
}
