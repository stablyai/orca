import type pg from 'pg'

export type PostgresPoolPressureCounts = {
  databasePoolTotal: number
  databasePoolIdle: number
  databasePoolWaiting: number
  databasePoolWaitersMax: number
  databasePoolOldestWaitMs: number
  databasePoolWaitMsMax: number
}

// A pool that cannot hand out a client throws a bare Error with no SQLSTATE, so
// the message is all node-postgres gives us. Both of these come only from
// pg-pool's connect path, so neither can be a statement that already ran.
const POOL_CONNECT_TIMEOUT_MESSAGES = [
  // No pooled client came free within connectionTimeoutMillis.
  'timeout exceeded when trying to connect',
  // A new client's own handshake outran connectionTimeoutMillis.
  'Connection terminated due to connection timeout'
]
// pg raises this whenever a socket ends early, during the handshake and mid
// statement alike, so only the acquire boundary can tell the two apart.
const CONNECTION_TERMINATED_MESSAGE = 'Connection terminated unexpectedly'

// Membership is tracked beside the error rather than on it: an error object may
// be frozen, and a mutated one would leak the marker into logs.
const poolAcquireFailures = new WeakSet<object>()

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown } | null)?.message)
}

function isPostgresPoolAcquireFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && poolAcquireFailures.has(error)
}

// connectionTimeoutMillis firing, either waiting in the queue or dialling.
export function isPostgresPoolConnectTimeout(error: unknown): boolean {
  const message = errorMessage(error)
  return POOL_CONNECT_TIMEOUT_MESSAGES.some((known) => message.includes(known))
}

// Every way the pool can fail to hand out a usable client. An early-ended
// socket counts only at the acquire boundary: retrying a statement whose commit
// outcome is unknown is not safe.
export function isPostgresPoolConnectFailure(error: unknown): boolean {
  if (isPostgresPoolConnectTimeout(error)) return true
  return (
    errorMessage(error).includes(CONNECTION_TERMINATED_MESSAGE) &&
    isPostgresPoolAcquireFailure(error)
  )
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
    if (this.pool.waitingCount <= waitingBefore) return await markedAcquire(connection)

    const waiter = Symbol()
    const startedAt = this.now()
    this.waiters.set(waiter, startedAt)
    this.waitersMax = Math.max(this.waitersMax, this.waiters.size)
    try {
      return await markedAcquire(connection)
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

async function markedAcquire(connection: Promise<pg.PoolClient>): Promise<pg.PoolClient> {
  try {
    return await connection
  } catch (error) {
    if (typeof error === 'object' && error !== null) poolAcquireFailures.add(error)
    throw error
  }
}

export function emptyPostgresPoolPressureCounts(): PostgresPoolPressureCounts {
  return emptyCounts()
}
