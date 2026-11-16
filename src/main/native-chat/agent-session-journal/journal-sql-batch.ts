import type Database from '../../sqlite/sync-database'

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
    super('journal SQL batch failed', { cause })
  }
}

/** The worker passes a fixed drain boundary; callbacks and decoded state end with each SAVEPOINT. */
export class JournalSqlBatch {
  private failure: unknown

  constructor(
    private readonly db: Database.Database,
    private readonly checkpoint?: { beforeWrite(): Promise<void>; afterCommit(): void }
  ) {}

  get fault(): unknown {
    return this.failure
  }

  /** Commands may await only microtasks: the worker owns the connection while one is open. */
  async run<Command, Value>(
    commands: readonly Command[],
    apply: (command: Command) => Value | Promise<Value>,
    durability: 'normal' | 'full' | 'retirement' = 'normal'
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
      await this.checkpoint?.beforeWrite()
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
