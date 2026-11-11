import { traceSessionSearch } from '../session-search-trace'
import type SyncDatabase from '../../sqlite/sync-database'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import type {
  TranscriptMessage,
  TranscriptReadOutcome,
  TranscriptSessionIdentity
} from '../../ai-vault/transcripts/session-transcript-consumers'
import { SessionSearchWriteBuffer, SessionSearchStagingBudget } from './session-search-write-buffer'
import {
  EMPTY_CONTENT_HASH,
  foldContentHash,
  type SessionContentHash
} from './session-search-content-hash'
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

/** Chunk named reads at this decoded-text threshold; anonymous reads spill before atomic publication. */
export const SESSION_SEARCH_COMMIT_CHARS = 32 * 1024 * 1024

/** No resume offset exists for a mid-read chunk; force a whole read after interruption. */
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
  /** Commit named chunks at the ceiling; spill anonymous reads privately until atomic publication. */
  add(message: TranscriptMessage): void
  failed?(): boolean
  cancelled?(): boolean
  drain?(): Promise<void>
  addPrepared?(rows: Iterable<TranscriptMessage>, hash: SessionContentHash): void
  /** Atomically publish final rows, metadata, and cursor; return false if the source changed meanwhile. */
  commit(outcome: TranscriptReadOutcome): boolean
  /** Ends an incomplete or failed read without publishing its buffered rows. */
  discard(): void
}

export class SessionSearchIndexWriter {
  private readonly records: SessionSearchFileRecords
  private readonly activeWrites = new Map<string, { removed: boolean; readers: number }>()
  private readonly pendingBuffers = new Set<SessionSearchWriteBuffer>()
  private readonly staging = new SessionSearchStagingBudget()
  private closed = false

  constructor(
    private readonly db: SyncDatabase,
    private readonly commitChars: number = SESSION_SEARCH_COMMIT_CHARS,
    /** Schedule bounded orphan reclamation after commit; synchronous cleanup would enlarge the transaction. */
    private readonly onOrphanedRows: () => void = () => undefined,
    private readonly onMessagesChanged: (delta: number) => void = () => undefined
  ) {
    this.records = new SessionSearchFileRecords(db)
  }

  /** Return null for unknown/replaced files; retain partial files with null byteOffset to force a whole read. */
  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The files schema defines FileRow; REAL casts return numeric IDs or null.
    const row = this.db
      .prepare(
        // REAL recovers the original numeric stat IDs, including existing oversized INTEGER rows.
        `SELECT CAST(dev AS REAL) AS dev, CAST(ino AS REAL) AS ino,
                byte_offset, mtime_ms, size_bytes, session_row_id FROM files WHERE path = ?`
      )
      .get(path) as FileRow | undefined
    if (!row) {
      return null
    }
    // Older indexes can carry half-pairs; only a complete identity can prove replacement.
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

  /** Accept append writes only when their starting offset matches this index’s own cursor. */
  beginWrite(
    candidate: SessionFileCandidate,
    mode: 'replace' | 'append',
    previousByteOffset: number,
    identity?: () => TranscriptSessionIdentity | null,
    _indexing?: boolean,
    _signal?: AbortSignal
  ): SessionSearchFileWrite | null {
    if (this.closed) {
      return null
    }
    const path = candidate.file.path
    const cursor = this.cursor(path)
    if (mode === 'append') {
      if (cursor === undefined || cursor.byte_offset === PARTIAL_FILE_CURSOR) {
        return null
      }
      if (cursor.byte_offset !== previousByteOffset) {
        return null
      }
    }
    // Empty decoded sessions still have resumable cursors; create their session row when content arrives.
    return this.buffered(candidate, cursor, mode === 'append', identity)
  }

  /** Atomically delete source rows and fence active writers; message deletion is intentionally unbounded. */
  removeFile(path: string): void {
    const active = this.activeWrites.get(path)
    if (active) {
      active.removed = true
      this.activeWrites.delete(path)
    }
    const cursor = this.cursor(path)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const removed = this.dropSession(cursor?.session_row_id ?? null)
      this.db.prepare('DELETE FROM files WHERE path = ?').run(path)
      this.db.exec('COMMIT')
      this.onMessagesChanged(-removed)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.closed = true
    for (const buffer of this.pendingBuffers) {
      buffer.release()
    }
    this.pendingBuffers.clear()
    for (const active of this.activeWrites.values()) {
      active.removed = true
    }
    this.activeWrites.clear()
  }

  private cursor(path: string): FileCursor | undefined {
    return this.db
      .prepare('SELECT session_row_id,byte_offset FROM files WHERE path = ?')
      .get(path) as FileCursor | undefined
  }

  private buffered(
    candidate: SessionFileCandidate,
    opened: FileCursor | undefined,
    append: boolean,
    identity?: () => TranscriptSessionIdentity | null
  ): SessionSearchFileWrite {
    const db = this.db
    const path = candidate.file.path
    const buffer = new SessionSearchWriteBuffer(this.commitChars, this.staging)
    this.pendingBuffers.add(buffer)
    // Recheck inside each transaction to prevent stale chunks resurrecting deleted or superseded rows.
    let expected = opened
    let session = opened?.session_row_id ?? null
    let hash = append && session !== null ? this.records.contentHash(session) : EMPTY_CONTENT_HASH
    const lifetime = this.activeWrites.get(path) ?? { removed: false, readers: 0 }
    lifetime.readers++
    this.activeWrites.set(path, lifetime)
    let released = false
    const discard = (): void => {
      if (released) {
        return
      }
      released = true
      buffer.release()
      this.pendingBuffers.delete(buffer)
      lifetime.readers--
      if (lifetime.readers === 0 && this.activeWrites.get(path) === lifetime) {
        this.activeWrites.delete(path)
      }
    }
    // Replace the session once, hiding old messages through joins; reclaim orphans after commit.
    let replaced = append
    let orphaned = false
    // Stop buffering after a fence failure rather than opening a doomed transaction per message.
    let fenced = false

    // A missing cursor cannot distinguish a first read from its removed source.
    const current = (): boolean => {
      if (lifetime.removed) {
        return false
      }
      const row = this.cursor(path)
      return (
        row?.session_row_id === expected?.session_row_id &&
        row?.byte_offset === expected?.byte_offset
      )
    }

    const write = (
      outcome: TranscriptReadOutcome | null,
      named: TranscriptSessionIdentity | null
    ): boolean =>
      traceSessionSearch(
        append ? 'commit' : 'replace',
        () => {
          const decoded = outcome?.session ?? null
          db.exec('BEGIN IMMEDIATE')
          let delta = 0
          try {
            if (!current()) {
              db.exec('ROLLBACK')
              return false
            }
            if (outcome && !decoded) {
              // Advance the cursor even without a decoded session to avoid rereading the same empty content.
              delta -= this.dropSession(session)
              session = null
              this.records.upsertFile(candidate, outcome.byteOffset, null, outcome.prefixHash)
            } else {
              if (replaced) {
                session ??= this.records.createSessionRow(candidate)
              } else {
                const previous = session
                session = this.records.createSessionRow(candidate)
                if (previous !== null) {
                  db.prepare('DELETE FROM sessions WHERE id = ?').run(previous)
                  orphaned = true
                }
                replaced = true
              }
              for (const row of buffer.rows()) {
                insertSearchMessage(db, session, row)
                delta++
              }
              if (decoded) {
                this.records.updateSession(decoded, session, hash)
              } else if (named) {
                // Committed chunks need searchable identity even if the read never finishes.
                this.records.updateProvisionalSession(session, named, candidate)
              }
              this.records.upsertFile(
                candidate,
                outcome ? outcome.byteOffset : PARTIAL_FILE_CURSOR,
                session,
                outcome?.prefixHash
              )
            }
            db.exec('COMMIT')
            this.onMessagesChanged(delta)
          } catch (error) {
            db.exec('ROLLBACK')
            throw error
          }
          // Schedule reclamation only after commit; rolled-back generations remain live.
          if (orphaned) {
            orphaned = false
            this.onOrphanedRows()
          }
          expected = {
            session_row_id: session,
            byte_offset: outcome ? outcome.byteOffset : PARTIAL_FILE_CURSOR
          }
          buffer.clear()
          return true
        },
        { append: append ? 1 : 0, replace: append ? 0 : 1, rescueRejections: 0 }
      )

    const stage = (rows: Iterable<TranscriptMessage>): void => {
      if (released || fenced || this.closed) {
        discard()
        return
      }
      for (const row of rows) {
        buffer.add(row)
        if (!buffer.ready) {
          continue
        }
        const named = identity?.() ?? null
        if (!named && buffer.spillReady) {
          buffer.spill()
        } else if (named && !write(null, named)) {
          fenced = true
          discard()
          return
        }
      }
    }
    return {
      add: (message) => {
        hash = foldContentHash(hash, [message])
        stage(searchMessageRows([message]))
      },
      addPrepared: (rows, preparedHash) => {
        hash = preparedHash
        stage(rows)
      },
      commit: (outcome) => {
        try {
          return !released && !fenced && !this.closed && write(outcome, null)
        } finally {
          discard()
        }
      },
      discard
    }
  }

  private dropSession(sessionRowId: number | null): number {
    if (sessionRowId === null) {
      return 0
    }
    const removed = deleteSearchMessages(this.db, sessionRowId)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionRowId)
    return removed
  }
}
