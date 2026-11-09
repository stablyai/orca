import SyncDatabase from '../sqlite/sync-database'
import type { TranscriptMessage } from '../ai-vault/transcripts/session-transcript-consumers'
import { ownRetainedString } from '../../shared/own-retained-string'

/** Shared by all handles; a capped row can overshoot the resident budget by at most 16,256 bytes. */
export class SessionSearchStagingBudget {
  readonly buffers = new Set<SessionSearchWriteBuffer>()
  bytes = 0
  retain(bytes: number): void {
    this.bytes += bytes
    if (this.bytes > 8 * 1024 * 1024) {
      for (const buffer of this.buffers) {
        buffer.spill()
      }
    }
  }
}

/** Anonymous reads stay private until commit; large reads spill to a disposable SQLite file. */
export class SessionSearchWriteBuffer {
  private readonly pending: TranscriptMessage[] = []
  private characters = 0
  private spilledCharacters = 0
  private residentBytes = 0
  private spilled: SyncDatabase | null = null

  constructor(
    private readonly commitChars: number,
    private readonly budget = new SessionSearchStagingBudget()
  ) {
    budget.buffers.add(this)
  }

  get ready(): boolean {
    return this.characters >= this.commitChars
  }

  get spillReady(): boolean {
    return this.characters - this.spilledCharacters >= this.commitChars
  }

  get hasSpilled(): boolean {
    return this.spilled !== null
  }

  add(message: TranscriptMessage): void {
    message.text = ownRetainedString(message.text)
    this.pending.push(message)
    this.characters += message.text.length
    const bytes = message.text.length * 2 + 256
    this.residentBytes += bytes
    this.budget.retain(bytes)
  }

  spill(): void {
    if (!this.pending.length) {
      return
    }
    if (!this.spilled) {
      // An empty filename is a private temporary database deleted when its connection closes.
      this.spilled = new SyncDatabase('')
      // Why: per-handle native page caches must not grow with staged transcript size.
      this.spilled.exec(`PRAGMA temp_store = FILE; PRAGMA cache_size = -64;
        PRAGMA mmap_size = 0;
        CREATE TABLE messages(role TEXT NOT NULL, text TEXT NOT NULL, ts TEXT, text_truncated INTEGER NOT NULL)`)
    }
    const db = this.spilled
    db.exec('BEGIN')
    try {
      const insert = db.prepare(
        'INSERT INTO messages(role, text, ts, text_truncated) VALUES (?, ?, ?, ?)'
      )
      for (const row of this.pending) {
        insert.run(row.role, row.text, row.timestamp, row.textTruncated ? 1 : 0)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    this.pending.length = 0
    this.spilledCharacters = this.characters
    this.budget.bytes -= this.residentBytes
    this.residentBytes = 0
  }

  *rows(): Generator<TranscriptMessage> {
    if (this.spilled) {
      for (const row of this.spilled
        .prepare('SELECT role, text, ts, text_truncated FROM messages ORDER BY rowid')
        .iterate()) {
        if (
          (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'tool') ||
          typeof row.text !== 'string' ||
          (row.ts !== null && typeof row.ts !== 'string') ||
          (row.text_truncated !== 0 && row.text_truncated !== 1)
        ) {
          throw new Error('Invalid staged transcript message')
        }
        yield {
          role: row.role,
          text: row.text,
          timestamp: row.ts,
          ...(row.text_truncated === 1 ? { textTruncated: true as const } : {})
        }
      }
    }
    yield* this.pending
  }

  release(): void {
    this.clear()
    this.budget.buffers.delete(this)
  }

  clear(): void {
    this.budget.bytes -= this.residentBytes
    this.residentBytes = 0
    this.pending.length = 0
    this.characters = 0
    this.spilledCharacters = 0
    const spilled = this.spilled
    this.spilled = null
    spilled?.close()
  }
}
