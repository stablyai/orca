// One connection per profile; instance locks exclude other processes and host teardown closes it last.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import {
  openJournalDatabase,
  runJournalTransaction,
  type JournalTransactionObservation,
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
  readonly readOnly: boolean
  private stranded = false

  private constructor(
    opened: OpenJournalDatabase,
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
  transaction<T>(
    run: (db: Database.Database) => T,
    streamed = false,
    observation?: JournalTransactionObservation
  ): T {
    const db = this.db
    if (!streamed) {
      return runJournalTransaction(
        db,
        run,
        () => {
          this.stranded = true
        },
        observation
      )
    }
    // Synchronous level changes require no transaction; stranded recovery restores FULL first.
    db.pragma('synchronous = NORMAL')
    try {
      return runJournalTransaction(
        db,
        run,
        () => {
          this.stranded = true
        },
        observation
      )
    } finally {
      if (!db.isTransaction) {
        db.pragma('synchronous = FULL')
      }
    }
  }

  /** Close after stores drain; preserve failed-close handles for teardown retry. */
  close(): void {
    this.connection?.close()
    this.connection = null
  }

  /** Retry stranded ROLLBACK before every use; uncommitted shared state must never reach another chat. */
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
