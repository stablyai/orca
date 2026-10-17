// The host's one chat journal database: every structured chat on this state directory, in one
// file. Foreground writes and sliced maintenance share the host's one connection.
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
import { JournalMaintenance } from './journal-maintenance'

const JOURNAL_DATABASE_FILE = 'agent-session-journal.db'

export function journalDatabasePath(stateDirectory: string): string {
  return join(stateDirectory, JOURNAL_DATABASE_FILE)
}

export class JournalHostDatabase {
  private connection: Database.Database | null
  /** A newer Orca wrote the database: every chat's history reads, and no chat writes. */
  readonly readOnly: boolean
  /** Recovery must end a stranded transaction and restore foreground durability before reuse. */
  private stranded = false
  private readonly maintenance: JournalMaintenance | null

  private constructor(
    opened: OpenJournalDatabase,
    /** Where the database lives; per-runtime end records sit beside it. */
    readonly stateDirectory: string
  ) {
    this.connection = opened.db
    this.readOnly = opened.readOnly
    this.maintenance = !opened.maintenanceEnabled
      ? null
      : new JournalMaintenance(
          () => this.db,
          (run, mode) => this.runTransaction(run, mode, true)
        )
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
    const result = this.runTransaction(run, 'IMMEDIATE', streamed)
    this.maintenance?.changed()
    return result
  }

  private runTransaction<T>(
    run: (db: Database.Database) => T,
    mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE',
    relaxed = false
  ): T {
    const connection = this.db
    // Streamed text and re-derivable cleanup share the connection's durability owner.
    if (relaxed) {
      connection.pragma('synchronous = NORMAL')
    }
    try {
      return runJournalTransaction(
        connection,
        run,
        () => {
          this.stranded = true
        },
        mode
      )
    } finally {
      if (relaxed && !connection.isTransaction) {
        this.stranded = true
        this.rollBackStrandedTransaction(connection)
      }
    }
  }

  journalAppended(sessionId: string): void {
    this.maintenance?.appended(sessionId)
  }

  /** Last, after every store has drained. A close that fails keeps the handle, so the retried
   *  teardown closes this same connection. */
  close(): void {
    this.maintenance?.close()
    this.connection?.close()
    this.connection = null
  }

  /**
   * A failed transaction whose ROLLBACK failed too is still open: every later BEGIN would fail
   * inside it and every read would see rows that never committed. Each use retries rollback and FULL,
   * and until one goes through every chat is refused the way a journal that will not open is.
   */
  private rollBackStrandedTransaction(connection: Database.Database): void {
    try {
      if (connection.isTransaction) {
        connection.exec('ROLLBACK')
      }
      connection.pragma('synchronous = FULL')
    } catch (error) {
      throw journalOpenRefusalError(error)
    }
    this.stranded = false
  }
}
