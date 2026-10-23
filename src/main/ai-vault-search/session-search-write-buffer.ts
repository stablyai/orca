import SyncDatabase from '../sqlite/sync-database'
import type { TranscriptMessage } from '../ai-vault/session-transcript-consumers'
import { ownRetainedString } from '../../shared/own-retained-string'

/** Anonymous reads stay private until commit; large reads spill to a disposable SQLite file. */
export class SessionSearchWriteBuffer {
  private readonly pending: TranscriptMessage[] = []
  private characters = 0
  private spilled: SyncDatabase | null = null

  constructor(private readonly commitChars: number) {}

  get ready(): boolean {
    return this.characters >= this.commitChars
  }

  get hasSpilled(): boolean {
    return this.spilled !== null
  }

  add(message: TranscriptMessage): void {
    message.text = ownRetainedString(message.text)
    this.pending.push(message)
    this.characters += message.text.length
  }

  spill(): void {
    if (!this.spilled) {
      // An empty filename is a private temporary database deleted when its connection closes.
      this.spilled = new SyncDatabase('')
      this.spilled.exec(`PRAGMA temp_store = FILE;
        CREATE TABLE messages(role TEXT NOT NULL, text TEXT NOT NULL, ts TEXT)`)
    }
    const db = this.spilled
    db.exec('BEGIN')
    try {
      const insert = db.prepare('INSERT INTO messages(role, text, ts) VALUES (?, ?, ?)')
      for (const row of this.pending) {
        insert.run(row.role, row.text, row.timestamp)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    this.pending.length = 0
    this.characters = 0
  }

  *rows(): Generator<TranscriptMessage> {
    if (this.spilled) {
      for (const row of this.spilled
        .prepare('SELECT role, text, ts FROM messages ORDER BY rowid')
        .iterate()) {
        if (
          (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'tool') ||
          typeof row.text !== 'string' ||
          (row.ts !== null && typeof row.ts !== 'string')
        ) {
          throw new Error('Invalid staged transcript message')
        }
        yield { role: row.role, text: row.text, timestamp: row.ts }
      }
    }
    yield* this.pending
  }

  clear(): void {
    this.pending.length = 0
    this.characters = 0
    const spilled = this.spilled
    this.spilled = null
    spilled?.close()
  }
}
