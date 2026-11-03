import { JournalSqlOwner, type JournalReadConnection } from './journal-sql-owner'

type WaitingReader = ReturnType<typeof Promise.withResolvers<JournalSqlOwner>>
export type JournalReadLease = {
  read: JournalReadConnection
  prime: () => Promise<void>
  close: () => Promise<void>
}

/** Finite request snapshots share a bounded native pool; no reader falls back to the writer. */
export class JournalReaders {
  private readonly owners = new Set<JournalSqlOwner>()
  private readonly idle: JournalSqlOwner[] = []
  private readonly waiting: WaitingReader[] = []
  private readonly scopes = new Set<Promise<void>>()
  private closed = false

  constructor(
    private readonly filename: string,
    private readonly maximum = 4
  ) {}

  async acquire(prime = true): Promise<JournalReadLease> {
    if (this.closed) {
      throw new Error('journal readers are closing')
    }
    const scope = Promise.withResolvers<void>()
    this.scopes.add(scope.promise)
    const finish = () => {
      this.scopes.delete(scope.promise)
      scope.resolve()
    }
    let owner: JournalSqlOwner
    try {
      owner = await this.borrow()
    } catch (error) {
      finish()
      throw error
    }
    try {
      if (prime) {
        await owner.request({ type: 'snapshot', open: true })
      }
    } catch (error) {
      try {
        await this.retire(owner)
      } finally {
        finish()
      }
      throw error
    }
    let closing: Promise<void> | undefined
    let primed = prime
    return {
      read: owner.connection,
      prime: async () => {
        if (primed) {
          return
        }
        primed = true
        await owner.request({ type: 'snapshot', open: true })
      },
      close: () => (closing ??= this.release(owner, primed).finally(finish))
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const waiting of this.waiting.splice(0)) {
      waiting.reject(new Error('journal readers are closing'))
    }
    await Promise.all(this.scopes)
    this.idle.length = 0
    const failures: unknown[] = []
    for (const owner of this.owners) {
      try {
        await this.retire(owner)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, 'journal readers failed to close')
    }
  }

  private async borrow(): Promise<JournalSqlOwner> {
    if (this.closed) {
      throw new Error('journal readers are closing')
    }
    const idle = this.idle.pop()
    if (idle) {
      return idle
    }
    if (this.owners.size >= this.maximum) {
      const waiting = Promise.withResolvers<JournalSqlOwner>()
      this.waiting.push(waiting)
      return waiting.promise
    }
    const owner = new JournalSqlOwner(this.filename, { reader: true })
    this.owners.add(owner)
    try {
      await owner.opened()
      return owner
    } catch (error) {
      await this.retire(owner)
      throw error
    }
  }

  private async release(owner: JournalSqlOwner, primed: boolean): Promise<void> {
    if (this.closed) {
      await this.retire(owner)
      return
    }
    try {
      if (primed) {
        await owner.request({ type: 'snapshot', open: false })
      }
    } catch (error) {
      await this.retire(owner)
      throw error
    }
    const waiting = this.closed ? undefined : this.waiting.shift()
    if (waiting) {
      waiting.resolve(owner)
    } else {
      this.idle.push(owner)
    }
  }

  private async retire(owner: JournalSqlOwner): Promise<void> {
    await owner.close()
    this.owners.delete(owner)
    // A failed startup/read must free the capacity promised to the next request.
    const waiting = this.closed ? undefined : this.waiting.shift()
    if (waiting) {
      this.borrow().then(waiting.resolve, waiting.reject)
    }
  }
}
