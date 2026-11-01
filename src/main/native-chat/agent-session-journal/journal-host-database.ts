// One connection per profile; instance locks exclude other processes and host teardown closes it last.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import {
  openJournalDatabase,
  runJournalTransaction,
  type OpenJournalDatabase
} from './journal-database'
import { journalOpenRefusalError } from './journal-open-failure'
import { JournalCheckpointOwner } from './journal-checkpoint-owner'
import { AgentSessionJournalError } from './journal-write-guards'

const JOURNAL_DATABASE_FILE = 'agent-session-journal.db'

export function journalDatabasePath(stateDirectory: string): string {
  return join(stateDirectory, JOURNAL_DATABASE_FILE)
}

export class JournalHostDatabase {
  private connection: Database.Database | null
  readonly readOnly: boolean
  private stranded = false
  private readonly checkpoint: JournalCheckpointOwner | undefined
  private closing: Promise<void> | undefined

  private constructor(
    opened: OpenJournalDatabase,
    readonly stateDirectory: string
  ) {
    this.connection = opened.db
    this.readOnly = opened.readOnly
    if (!this.readOnly) {
      this.checkpoint = new JournalCheckpointOwner(opened.db, journalDatabasePath(stateDirectory))
    }
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
    if (!connection || this.closing) {
      throw new AgentSessionJournalError('journal_closed', 'the chat journal database is closed')
    }
    if (this.stranded) {
      this.rollBackStrandedTransaction(connection)
    }
    return connection
  }

  /** Streamed text may lose only its trailing suffix on OS crash; the next FULL commit makes it durable. */
  transaction<T>(
    run: (db: Database.Database) => T,
    streamed = false,
    committed?: (result: T) => void
  ): T {
    const db = this.db
    if (!streamed) {
      const result = runJournalTransaction(db, run, () => {
        this.stranded = true
      })
      committed?.(result)
      this.checkpoint?.afterCommit()
      return result
    }
    // Synchronous level changes require no transaction; stranded recovery restores FULL first.
    db.pragma('synchronous = NORMAL')
    let result: T
    try {
      result = runJournalTransaction(db, run, () => {
        this.stranded = true
      })
      committed?.(result)
    } finally {
      if (!db.isTransaction) {
        db.pragma('synchronous = FULL')
      }
    }
    this.checkpoint?.afterCommit()
    return result
  }

  /** Autocommit maintenance may commit earlier statements even when a later statement fails. */
  writeAutocommit<T>(run: (db: Database.Database) => T): T {
    const db = this.db
    try {
      return run(db)
    } finally {
      this.checkpoint?.afterCommit()
    }
  }

  /** Close after stores drain; preserve failed-close handles for teardown retry. */
  close(): Promise<void> {
    this.closing ??= this.finishClose().catch((error: unknown) => {
      this.closing = undefined
      throw error
    })
    return this.closing
  }

  private async finishClose(): Promise<void> {
    await this.checkpoint?.close()
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
