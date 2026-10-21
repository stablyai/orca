// The host's one chat journal database: every structured chat on this state directory, in one
// file, on one connection. The app and orcad instance locks keep a second process off a profile.
//
// A chat's store owns no connection. It goes through this object, so there is nothing per chat to
// open, close, retry or leak, and the connection closes exactly once, last, at host teardown.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import {
  openJournalDatabase,
  runJournalTransaction,
  type OpenJournalDatabase
} from './journal-database'
import { journalOpenRefusalError } from './journal-open-failure'
import { AgentSessionJournalError } from './journal-write-guards'

const JOURNAL_DATABASE_FILE = 'agent-session-journal.db'

export function journalDatabasePath(stateDirectory: string): string {
  return join(stateDirectory, JOURNAL_DATABASE_FILE)
}

export class JournalHostDatabase {
  private connection: Database.Database | null
  /** A newer Orca wrote the database: every chat's history reads, and no chat writes. */
  readonly readOnly: boolean
  /** A failed transaction's ROLLBACK failed too, so the transaction may still be open. */
  private stranded = false

  private constructor(
    opened: OpenJournalDatabase,
    /** Where the database lives; per-runtime end records sit beside it. */
    readonly stateDirectory: string
  ) {
    this.connection = opened.db
    this.readOnly = opened.readOnly
  }

  static open(stateDirectory: string): JournalHostDatabase {
    mkdirSync(stateDirectory, { recursive: true })
    return new JournalHostDatabase(
      openJournalDatabase(journalDatabasePath(stateDirectory)),
      stateDirectory
    )
  }

  get isClosed(): boolean {
    return this.connection === null
  }

  get db(): Database.Database {
    const connection = this.connection
    if (!connection) {
      throw new AgentSessionJournalError('journal_closed', 'the chat journal database is closed')
    }
    if (this.stranded) {
      this.rollBackStrandedTransaction(connection)
    }
    return connection
  }

  /** One IMMEDIATE transaction; see `runJournalTransaction`. `streamed` commits without the per-commit
   *  fsync: only for rows an OS crash may lose (`isJournalStreamedTextRevision`); the next FULL
   *  commit makes them durable, so a crash can only lose a suffix of them. */
  transaction<T>(run: (db: Database.Database) => T, streamed = false): T {
    const db = this.db
    if (!streamed) {
      return runJournalTransaction(db, run, () => {
        this.stranded = true
      })
    }
    // The level can change only outside a transaction; a stranded one restores FULL on recovery.
    db.pragma('synchronous = NORMAL')
    try {
      return runJournalTransaction(db, run, () => {
        this.stranded = true
      })
    } finally {
      if (!db.isTransaction) {
        db.pragma('synchronous = FULL')
      }
    }
  }

  /** Last, after every store has drained. A close that fails keeps the handle, so the retried
   *  teardown closes this same connection. */
  close(): void {
    this.connection?.close()
    this.connection = null
  }

  /**
   * A failed transaction whose ROLLBACK failed too is still open: every later BEGIN would fail
   * inside it and every read would see rows that never committed. Each use retries the ROLLBACK,
   * and until one goes through every chat is refused the way a journal that will not open is.
   */
  private rollBackStrandedTransaction(connection: Database.Database): void {
    if (connection.isTransaction) {
      try {
        connection.exec('ROLLBACK')
      } catch (error) {
        throw journalOpenRefusalError(error)
      }
    }
    connection.pragma('synchronous = FULL')
    this.stranded = false
  }
}
