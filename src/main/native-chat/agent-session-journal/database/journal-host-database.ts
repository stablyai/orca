// One connection per profile; instance locks exclude other processes and host teardown closes it last.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type Database from '../../../sqlite/sync-database'
import {
  openJournalDatabase,
  runJournalTransaction,
  type OpenJournalDatabase
} from './journal-database'
import { journalOpenRefusalError } from '../replay/journal-open-failure'
import { JournalCheckpointOwner } from './journal-checkpoint-owner'
import { readJournalSessionEpoch } from '../durable-rows/journal-row-table'
import { AgentSessionJournalError } from '../writing/journal-write-guards'

const JOURNAL_DATABASE_FILE = 'agent-session-journal.db'

export function journalDatabasePath(stateDirectory: string): string {
  return join(stateDirectory, JOURNAL_DATABASE_FILE)
}

/** What journal collaborators need from a connection owner; the SQL writer supplies its own. */
export type JournalTransactionalDatabase = Pick<
  JournalHostDatabase,
  'db' | 'readOnly' | 'stateDirectory' | 'transaction'
>

export class JournalHostDatabase {
  private connection: Database.Database | null
  readonly readOnly: boolean
  private stranded = false
  private readonly checkpoint: JournalCheckpointOwner | undefined
  private closing: Promise<void> | undefined
  /** Identifies the open transaction; drafts staged in a rolled-back one must not be built on. */
  transactionNumber = 0

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

  async sessionEpoch(sessionId: string): Promise<string | null> {
    return readJournalSessionEpoch(this.db, sessionId)
  }

  transaction<T>(run: (db: Database.Database) => T, committed?: (result: T) => void): T {
    const db = this.db
    this.transactionNumber += 1
    const result = runJournalTransaction(db, run, () => {
      this.stranded = true
    })
    committed?.(result)
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
    this.stranded = false
  }
}
