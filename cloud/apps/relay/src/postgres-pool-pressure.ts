import type pg from 'pg'

export type PostgresPoolPressureCounts = {
  databasePoolTotal: number
  databasePoolIdle: number
  databasePoolWaiting: number
  databasePoolWaitersMax: number
  databasePoolOldestWaitMs: number
  databasePoolWaitMsMax: number
}

const emptyCounts = (): PostgresPoolPressureCounts => ({
  databasePoolTotal: 0,
  databasePoolIdle: 0,
  databasePoolWaiting: 0,
  databasePoolWaitersMax: 0,
  databasePoolOldestWaitMs: 0,
  databasePoolWaitMsMax: 0
})

export class PostgresPoolPressure {
  private readonly waiters = new Map<symbol, number>()
  private waitersMax = 0
  private waitMsMax = 0
  private lastConsumed = emptyCounts()

  constructor(
    private readonly pool: pg.Pool,
    private readonly now: () => number = Date.now
  ) {}

  async connect(): Promise<pg.PoolClient> {
    const waitingBefore = this.pool.waitingCount
    const connection = this.pool.connect()
    if (this.pool.waitingCount <= waitingBefore) return await connection

    const waiter = Symbol()
    const startedAt = this.now()
    this.waiters.set(waiter, startedAt)
    this.waitersMax = Math.max(this.waitersMax, this.waiters.size)
    try {
      return await connection
    } finally {
      this.waitMsMax = Math.max(this.waitMsMax, this.now() - startedAt)
      this.waiters.delete(waiter)
    }
  }

  consumeCounts(): PostgresPoolPressureCounts {
    const counts = this.readCounts()
    this.lastConsumed = counts
    this.waitersMax = this.waiters.size
    this.waitMsMax = counts.databasePoolOldestWaitMs
    return counts
  }

  peekCounts(): PostgresPoolPressureCounts {
    const current = this.readCounts()
    return {
      ...current,
      databasePoolWaitersMax: Math.max(
        current.databasePoolWaitersMax,
        this.lastConsumed.databasePoolWaitersMax
      ),
      databasePoolOldestWaitMs: Math.max(
        current.databasePoolOldestWaitMs,
        this.lastConsumed.databasePoolOldestWaitMs
      ),
      databasePoolWaitMsMax: Math.max(
        current.databasePoolWaitMsMax,
        this.lastConsumed.databasePoolWaitMsMax
      )
    }
  }

  private readCounts(): PostgresPoolPressureCounts {
    const now = this.now()
    const oldestWaitMs =
      this.waiters.size === 0 ? 0 : Math.max(0, now - Math.min(...this.waiters.values()))
    return {
      databasePoolTotal: this.pool.totalCount,
      databasePoolIdle: this.pool.idleCount,
      databasePoolWaiting: this.waiters.size,
      databasePoolWaitersMax: Math.max(this.waitersMax, this.waiters.size),
      databasePoolOldestWaitMs: oldestWaitMs,
      databasePoolWaitMsMax: Math.max(this.waitMsMax, oldestWaitMs)
    }
  }
}

export function emptyPostgresPoolPressureCounts(): PostgresPoolPressureCounts {
  return emptyCounts()
}
