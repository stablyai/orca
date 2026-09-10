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
import {
  deleteSearchMessages,
  insertSearchMessage,
  searchMessageRows
} from './session-search-message-rows'

/**
 * How much decoded text one transaction may carry.
 *
 * A file's rows are buffered in memory and written in one transaction, so the
 * whole read is either in the index or not. The ceiling is what keeps that
 * promise affordable: at the measured 26 MB of transcript per second it caps a
 * single commit near a second and the WAL it produces near 64 MB, and it is far
 * above the largest real transcript (the 40-session benchmark corpus is 10.5 MB
 * in total), so an ordinary file never reaches it. Above the ceiling the read is
 * cut into chunks that each leave the index consistent — see `chunked`.
 */
export const SESSION_SEARCH_COMMIT_CHARS = 32 * 1024 * 1024

/**
 * The cursor of a file whose rows are a prefix, written by a chunk of a read
 * that has not reached the end of the file.
 *
 * The reader hands out byte offsets only when a read finishes, so a chunk has
 * no honest offset to record. This one is unusable on purpose: `indexedFile`
 * reports no cursor for it, so an append is declined and the file is re-read
 * whole. The rows are still a coherent prefix of that session and answer
 * searches until the re-read replaces them.
 */
const PARTIAL_FILE_CURSOR = -1

type FileRow = {
  dev: number | null
  ino: number | null
  byte_offset: number
  mtime_ms: number
  size_bytes: number | null
  session_row_id: number | null
}

type FileCursor = Pick<FileRow, 'session_row_id' | 'byte_offset'>

export type SessionSearchFileWrite = {
  /** Buffers one message, committing a chunk when the buffer reaches the ceiling. */
  add(message: TranscriptMessage): void
  /**
   * Writes this file's rows, its session and its cursor in one transaction.
   * False when the file's record changed under this read — it was removed, or
   * another writer moved the cursor these rows continue from. A read that never
   * calls this leaves the index exactly as it found it, unless it chunked.
   */
  commit(outcome: TranscriptReadOutcome): boolean
}

export class SessionSearchIndexWriter {
  private readonly records: SessionSearchFileRecords
  // Removals per path, so a write can prove its source was not dropped under it
  // rather than infer it from the cursor. In memory is enough: one process owns
  // the index, and a removal only has to fence writes this process opened.
  private readonly removals = new Map<string, number>()

  constructor(
    private readonly db: SyncDatabase,
    private readonly commitChars: number = SESSION_SEARCH_COMMIT_CHARS
  ) {
    this.records = new SessionSearchFileRecords(db)
  }

  /**
   * What the index holds for this file, or null when it holds nothing usable:
   * an unknown path, or one whose recorded identity no longer matches.
   *
   * A file a chunked read left half written is reported, with a null cursor.
   * Reporting nothing for it would read as "never indexed", so the caller would
   * ask for whatever read the parse cache offers, the reader would pick append,
   * and the decline would be the only thing that ever forced the whole read.
   */
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
    return {
      byteOffset: row.byte_offset === PARTIAL_FILE_CURSOR ? null : row.byte_offset,
      mtimeMs: row.mtime_ms,
      sizeBytes: row.size_bytes
    }
  }

  /**
   * Opens a buffered write for one read, or returns null when the read cannot
   * extend what the index holds: an `append` whose predecessor byte offset is
   * not this index's own cursor covers a span the index never saw.
   */
  beginWrite(
    candidate: SessionFileCandidate,
    mode: 'replace' | 'append',
    previousByteOffset: number
  ): SessionSearchFileWrite | null {
    const path = candidate.file.path
    const cursor = this.cursor(path)
    if (mode === 'append') {
      // The partial sentinel is not a byte offset, so nothing continues it —
      // including a caller that reads it back off the row and passes it in.
      if (cursor === undefined || cursor.byte_offset === PARTIAL_FILE_CURSOR) {
        return null
      }
      if (cursor.byte_offset !== previousByteOffset) {
        return null
      }
    }
    // A file the index read through and decoded no session from still has a
    // cursor worth continuing: it has no session row to hang new rows off, so
    // this read makes one. Declining instead would force a whole re-read of
    // that file on every pass for as long as it grows.
    return this.buffered(candidate, cursor, mode === 'append')
  }

  /**
   * Drops a source: its session, its rows and its file record, in one
   * transaction. Unbounded on purpose — the caller has proven this one file is
   * gone and expects it out of results when the call returns, and a read of it
   * that is still in flight is fenced by the cursor its commit re-reads.
   */
  removeFile(path: string): void {
    this.removals.set(path, (this.removals.get(path) ?? 0) + 1)
    const cursor = this.cursor(path)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.dropSession(cursor?.session_row_id ?? null)
      this.db.prepare('DELETE FROM files WHERE path = ?').run(path)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private cursor(path: string): FileCursor | undefined {
    return this.db
      .prepare('SELECT session_row_id,byte_offset FROM files WHERE path = ?')
      .get(path) as FileCursor | undefined
  }

  private buffered(
    candidate: SessionFileCandidate,
    opened: FileCursor | undefined,
    append: boolean
  ): SessionSearchFileWrite {
    const db = this.db
    const path = candidate.file.path
    const buffer: TranscriptMessage[] = []
    let bufferedChars = 0
    // What this write believes the file record holds. Re-read inside every
    // transaction: a `removeFile` or another writer between two chunks means
    // these rows no longer continue anything, and committing on top of that
    // would resurrect a deleted source or duplicate a span.
    let expected = opened
    const removalsAtStart = this.removals.get(path) ?? 0
    // The session row is reused across re-reads of one file, so a `replace`
    // swaps a session's rows rather than minting a second generation of it.
    let session = opened?.session_row_id ?? null
    let hash = append && session !== null ? this.records.contentHash(session) : EMPTY_CONTENT_HASH
    // A replace owns the session's whole row set, so the old generation goes in
    // the same transaction as the first of the new one. Chunk two onwards must
    // not repeat it.
    let replaced = append
    // Set when the file record moved under this read. Nothing this write holds
    // can land after that, so it stops buffering rather than reopening a
    // transaction it already knows will roll back, once per remaining message.
    let fenced = false

    // Why a counter and not the cursor alone: on a path this index never wrote,
    // `expected` and the absent row are both undefined, so the cursor compare
    // reads a removal as no change and the write recreates the source.
    const current = (): boolean => {
      if ((this.removals.get(path) ?? 0) !== removalsAtStart) {
        return false
      }
      const row = this.cursor(path)
      return (
        row?.session_row_id === expected?.session_row_id &&
        row?.byte_offset === expected?.byte_offset
      )
    }

    /** `outcome` is null for a chunk of a read that has not reached the file's end. */
    const write = (outcome: TranscriptReadOutcome | null): boolean => {
      const decoded = outcome?.session ?? null
      db.exec('BEGIN IMMEDIATE')
      try {
        if (!current()) {
          db.exec('ROLLBACK')
          return false
        }
        if (outcome && !decoded) {
          // Read through, but nothing to search: the cursor advances so the file
          // is not re-read whole on every pass, and whatever generation was here
          // — including this read's own committed chunks — goes with it.
          this.dropSession(session)
          session = null
          this.records.upsertFile(candidate, outcome.byteOffset, null)
        } else {
          session ??= this.records.createSessionRow(candidate)
          if (!replaced) {
            deleteSearchMessages(db, session)
            replaced = true
          }
          for (const row of buffer) {
            insertSearchMessage(db, session, row)
          }
          if (decoded) {
            this.records.updateSession(decoded, session, hash)
          }
          this.records.upsertFile(
            candidate,
            outcome ? outcome.byteOffset : PARTIAL_FILE_CURSOR,
            session
          )
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      expected = {
        session_row_id: session,
        byte_offset: outcome ? outcome.byteOffset : PARTIAL_FILE_CURSOR
      }
      buffer.length = 0
      bufferedChars = 0
      return true
    }

    return {
      add: (message) => {
        if (fenced) {
          return
        }
        hash = foldContentHash(hash, [message])
        for (const row of searchMessageRows([message])) {
          buffer.push(row)
          bufferedChars += row.text.length
        }
        if (bufferedChars >= this.commitChars && !write(null)) {
          fenced = true
          buffer.length = 0
          bufferedChars = 0
        }
      },
      commit: (outcome) => !fenced && write(outcome)
    }
  }

  /** Caller's transaction: drops a session and every row that hangs off it. */
  private dropSession(sessionRowId: number | null): void {
    if (sessionRowId === null) {
      return
    }
    deleteSearchMessages(this.db, sessionRowId)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionRowId)
  }
}
