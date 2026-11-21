import type Database from '../../sqlite/sync-database'
import { storageCapacityErrorCode } from '../../../shared/errors/storage-capacity-error'
import { isSqliteDriverError } from '../../sqlite/sqlite-read-failure'

export type JournalSqlBatchOutcome<Value> =
  | { committed: true; value: Value }
  | { committed: false; error: unknown }

export type JournalSqlBatchResult<Value> = {
  outcomes: JournalSqlBatchOutcome<Value>[]
}

export class JournalSqlBatchError extends Error {
  override readonly name = 'JournalSqlBatchError'

  constructor(
    readonly outcome: 'not-dispatched' | 'rolled-back' | 'indeterminate',
    cause: unknown,
    readonly rollback?: unknown
  ) {
    super(batchFailureMessage(cause), { cause })
  }
}

// The worker transport keeps only the message, so carry the cause's text in it.
function batchFailureMessage(cause: unknown): string {
  if (cause instanceof JournalSqlBatchError) {
    return cause.message
  }
  return cause instanceof Error
    ? `journal SQL batch failed: ${cause.message}`
    : 'journal SQL batch failed'
}

/** The worker passes a fixed drain boundary; callbacks and decoded state end with each SAVEPOINT. */
export class JournalSqlBatch {
  private failure: unknown

  constructor(
    private readonly db: Database.Database,
    private readonly checkpoint?: {
      beforeWrite(urgent?: boolean): Promise<void>
      afterCommit(): void
    }
  ) {}

  get fault(): unknown {
    return this.failure
  }

  /** Commands may await only microtasks: the worker owns the connection while one is open. */
  async run<Command, Value>(
    commands: readonly Command[],
    apply: (command: Command) => Value | Promise<Value>,
    durability: 'normal' | 'full' | 'retirement' = 'normal',
    urgent = false
  ): Promise<JournalSqlBatchResult<Value>> {
    if (this.failure) {
      throw new JournalSqlBatchError('not-dispatched', this.failure)
    }
    const outcomes: JournalSqlBatchOutcome<Value>[] = []
    if (commands.length === 0) {
      return { outcomes }
    }
    const drain = commands.slice()
    const pragmas =
      durability === 'retirement'
        ? ['synchronous', 'busy_timeout', 'fullfsync', 'checkpoint_fullfsync'].map(
            (name) => [name, this.db.pragma(name, { simple: true })] as const
          )
        : []
    let began = false
    let committing = false
    let failed: JournalSqlBatchError | undefined
    try {
      await this.checkpoint?.beforeWrite(urgent)
      if (durability !== 'normal') {
        this.db.pragma('synchronous=FULL')
        if (durability === 'retirement') {
          this.db.pragma('busy_timeout=0')
          this.db.pragma('fullfsync=ON')
          this.db.pragma('checkpoint_fullfsync=ON')
        }
      }
      this.db.exec('BEGIN IMMEDIATE')
      began = true
      for (const command of drain) {
        this.db.exec('SAVEPOINT journal_command')
        try {
          const value = await apply(command)
          this.db.exec('RELEASE journal_command')
          outcomes.push({ committed: true, value })
        } catch (error) {
          // An error such as SQLITE_FULL can roll back the whole transaction, SAVEPOINT included.
          if (!this.db.isTransaction) {
            throw error
          }
          // Failure here escapes to the outer rollback; no earlier success is then acknowledged.
          this.db.exec('ROLLBACK TO journal_command; RELEASE journal_command')
          outcomes.push({ committed: false, error })
        }
      }
      committing = true
      this.db.exec('COMMIT')
    } catch (cause) {
      let rollback: unknown
      let rolledBack = !this.db.isTransaction && storageCapacityErrorCode(cause) === 'SQLITE_FULL'
      if (this.db.isTransaction) {
        try {
          this.db.exec('ROLLBACK')
          rolledBack = true
        } catch (error) {
          rollback = error
        }
      }
      // A COMMIT is settled only when SQLite itself rejected it and the rollback is confirmed.
      const indeterminate = rollback || (committing && !(rolledBack && isSqliteDriverError(cause)))
      failed = new JournalSqlBatchError(
        indeterminate ? 'indeterminate' : began ? 'rolled-back' : 'not-dispatched',
        cause,
        rollback
      )
      if (indeterminate) {
        this.failure = failed
      }
    } finally {
      if (durability !== 'normal' && !this.db.isTransaction) {
        try {
          if (durability === 'retirement') {
            for (const [name, value] of pragmas) {
              this.db.pragma(`${name}=${Number(value)}`)
            }
          } else {
            this.db.pragma('synchronous=NORMAL')
          }
        } catch (cause) {
          failed ??= new JournalSqlBatchError('indeterminate', cause)
          this.failure = failed
        }
      }
      this.checkpoint?.afterCommit()
    }
    if (failed) {
      throw failed
    }
    return { outcomes }
  }
}
