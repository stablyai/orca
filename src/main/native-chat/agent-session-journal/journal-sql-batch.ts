import type Database from '../../sqlite/sync-database'

export type JournalSqlBatchOutcome<Value> =
  | { committed: true; value: Value }
  | { committed: false; error: unknown }

export type JournalSqlBatchResult<Value> = {
  outcomes: JournalSqlBatchOutcome<Value>[]
  postcommit?: unknown
}

export class JournalSqlBatchError extends Error {
  override readonly name = 'JournalSqlBatchError'

  constructor(
    readonly outcome: 'not-dispatched' | 'rolled-back' | 'indeterminate',
    cause: unknown,
    readonly rollback?: unknown
  ) {
    super('journal SQL batch failed', { cause })
  }
}

/** The worker passes a fixed drain boundary; callbacks and decoded state end with each SAVEPOINT. */
export class JournalSqlBatch {
  private failure: unknown

  constructor(private readonly db: Database.Database) {}

  get fault(): unknown {
    return this.failure
  }

  /** Commands may await only microtasks: the worker owns the connection while one is open. */
  async run<Command, Value>(
    commands: readonly { command: Command; normal: boolean }[],
    apply: (command: Command) => Value | Promise<Value>
  ): Promise<JournalSqlBatchResult<Value>> {
    if (this.failure) {
      throw new JournalSqlBatchError('not-dispatched', this.failure)
    }
    const outcomes: JournalSqlBatchOutcome<Value>[] = []
    if (commands.length === 0) {
      return { outcomes }
    }
    const drain = commands.slice()
    const normal = drain.every((entry) => entry.normal)
    let began = false
    let committing = false
    let failed: JournalSqlBatchError | undefined
    let postcommit: unknown
    try {
      // Re-prove FULL before every drain, including after a failed PRAGMA from an earlier drain.
      this.db.pragma('synchronous = FULL')
      if (normal) {
        this.db.pragma('synchronous = NORMAL')
      }
      this.db.exec('BEGIN IMMEDIATE')
      began = true
      for (const { command } of drain) {
        this.db.exec('SAVEPOINT journal_command')
        try {
          const value = await apply(command)
          this.db.exec('RELEASE journal_command')
          outcomes.push({ committed: true, value })
        } catch (error) {
          // Failure here escapes to the outer rollback; no earlier success is then acknowledged.
          this.db.exec('ROLLBACK TO journal_command; RELEASE journal_command')
          outcomes.push({ committed: false, error })
        }
      }
      committing = true
      this.db.exec('COMMIT')
    } catch (cause) {
      let rollback: unknown
      if (this.db.isTransaction) {
        try {
          this.db.exec('ROLLBACK')
        } catch (error) {
          rollback = error
        }
      }
      failed = new JournalSqlBatchError(
        committing || rollback ? 'indeterminate' : began ? 'rolled-back' : 'not-dispatched',
        cause,
        rollback
      )
      if (committing || rollback) {
        this.failure = failed
      }
    } finally {
      if (normal && !this.db.isTransaction) {
        try {
          this.db.pragma('synchronous = FULL')
        } catch (error) {
          // The COMMIT answer remains true; the owner reports this fault after its acknowledgement.
          postcommit = error
          this.failure ??= error
        }
      }
    }
    if (failed) {
      throw failed
    }
    return { outcomes, ...(postcommit ? { postcommit } : {}) }
  }
}
