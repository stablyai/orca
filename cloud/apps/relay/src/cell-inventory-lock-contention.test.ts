import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => ({
  statements: [] as string[],
  query: vi.fn(async (sql: string) => {
    fakes.statements.push(sql)
    return { rows: [], rowCount: 0 }
  }),
  release: vi.fn(),
  end: vi.fn(async () => undefined)
}))

vi.mock('pg', () => ({
  default: {
    Pool: class {
      totalCount = 1
      idleCount = 1
      waitingCount = 0
      end = fakes.end
      on = vi.fn()
      connect = vi.fn(async () => ({ query: fakes.query, release: fakes.release }))
    }
  }
}))

const { CELL_INVENTORY_LOCK_TIMEOUT_MS, RelayAssignmentStore } = await import(
  './assignment-store.js'
)
const { consumeRelayCellInventoryHold, openInMemoryRelayDatabase, openRelayDatabase, POSTGRES_LOCK_TIMEOUT_MS } =
  await import('./database.js')
const RESTORE = `SET LOCAL lock_timeout = '${POSTGRES_LOCK_TIMEOUT_MS}ms'`
type RelayDatabase = import('./database.js').RelayDatabase
type RelayLockOptions = import('./database.js').RelayLockOptions
type RelayTransactionOptions = import('./database.js').RelayTransactionOptions
type SqlRow = import('./database.js').SqlRow

const CELL_INVENTORY_SQL = 'SELECT * FROM relay_cells ORDER BY cell_id ASC'

// The assignment path locks the general-admission subset; both forms are the
// same ordered scan of the same 23-row table and share its lock queue.
function locksCellInventory(sql: string): boolean {
  return sql.trim().startsWith('SELECT * FROM relay_cells') && sql.includes('ORDER BY cell_id ASC')
}
const CELLS = [
  { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
  { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
]
const identity = { userId: 'user-a', relayHostId: 'host000000000001' }

async function openFakePostgres(): Promise<RelayDatabase> {
  const database = await openRelayDatabase({
    databaseUrl: 'postgresql://relay:secret@127.0.0.1:5432/relay',
    dataDir: './unused'
  })
  fakes.statements.length = 0
  return database
}

afterEach(() => {
  fakes.statements.length = 0
  fakes.query.mockReset()
  fakes.query.mockImplementation(async (sql: string) => {
    fakes.statements.push(sql)
    return { rows: [], rowCount: 0 }
  })
})

describe('bounded cell-inventory lock wait', () => {
  // Why: a bound at or above the pool default would fence nothing, and one far
  // below the hold time would convert ordinary contention into terminal failures.
  it('keeps the request bound strictly inside the pool default', () => {
    expect(CELL_INVENTORY_LOCK_TIMEOUT_MS).toBe(500)
    expect(CELL_INVENTORY_LOCK_TIMEOUT_MS).toBeLessThan(POSTGRES_LOCK_TIMEOUT_MS)
  })

  // Why: SET LOCAL lasts to COMMIT. Left in place it would govern every later
  // locked statement in the transaction and misattribute their 55P03s.
  it('restores the pool default before the next statement in the transaction', async () => {
    const database = await openFakePostgres()

    await database.transaction(async (transaction) => {
      await transaction.queryLocked(CELL_INVENTORY_SQL, [], { lockTimeoutMs: 150 })
      await transaction.queryLocked('SELECT * FROM relay_assignments', [])
    })

    expect(fakes.statements).toEqual([
      'BEGIN',
      "SET LOCAL lock_timeout = '150ms'",
      `${CELL_INVENTORY_SQL} FOR UPDATE`,
      RESTORE,
      'SELECT * FROM relay_assignments FOR UPDATE',
      'COMMIT'
    ])
    await database.close()
  })

  it('restores the pool default when the bounded lock itself times out', async () => {
    const database = await openFakePostgres()
    fakes.query.mockImplementation(async (sql: string) => {
      fakes.statements.push(sql)
      if (sql.includes('FOR UPDATE')) {
        throw Object.assign(new Error('lock timeout'), { code: '55P03' })
      }
      return { rows: [], rowCount: 0 }
    })

    await expect(
      database.transaction(async (transaction) => {
        await transaction.queryLocked(CELL_INVENTORY_SQL, [], { lockTimeoutMs: 150 })
      })
    ).rejects.toMatchObject({ code: '55P03' })

    // The retry wrapper makes three attempts; each one must leave the default back.
    expect(fakes.statements.filter((sql) => sql.startsWith('SET LOCAL'))).toEqual(
      Array.from({ length: 3 }, () => ["SET LOCAL lock_timeout = '150ms'", RESTORE]).flat()
    )
    await database.close()
  })

  it('rejects a lock bound that is not a positive whole number of milliseconds', async () => {
    const database = await openFakePostgres()

    for (const lockTimeoutMs of [0, -1, 1.5, Number.NaN]) {
      await expect(
        database.transaction(
          async (transaction) =>
            await transaction.queryLocked(CELL_INVENTORY_SQL, [], { lockTimeoutMs })
        )
      ).rejects.toThrow('invalid_lock_timeout')
    }
    await database.close()
  })

  it('skips the timeout for a NOWAIT lock, which never queues', async () => {
    const database = await openFakePostgres()

    await database.transaction(async (transaction) => {
      await transaction.queryLocked(CELL_INVENTORY_SQL, [], {
        failIfUnavailable: true,
        lockTimeoutMs: 150
      })
    })

    expect(fakes.statements.filter((sql) => sql.startsWith('SET LOCAL'))).toEqual([])
    await database.close()
  })

  it('skips the timeout outside a transaction, where SET LOCAL cannot survive', async () => {
    const database = await openFakePostgres()

    await database.queryLocked(CELL_INVENTORY_SQL, [], { lockTimeoutMs: 150 })

    expect(fakes.statements).toEqual([`${CELL_INVENTORY_SQL} FOR UPDATE`])
    await database.close()
  })

  it('ignores the timeout on SQLite, which has no SET LOCAL', async () => {
    const database = await openInMemoryRelayDatabase()

    const rows = await database.transaction(
      async (transaction) =>
        await transaction.queryLocked(CELL_INVENTORY_SQL, [], { lockTimeoutMs: 150 })
    )

    expect(rows).toEqual([])
    await database.close()
  })

  // Why: testing the helper alone would pass with the store still queueing for
  // the pool's one-second default.
  // Why: testing the helper alone would pass with the request path still queueing
  // for the pool's full second.
  it('never lets a request path take the unbounded wait', async () => {
    const database = await openInMemoryRelayDatabase()
    const probe = new InventoryLockProbe(database)
    const store = new RelayAssignmentStore(probe, () => 1_000)
    await store.reconcileCells(CELLS)
    probe.inventoryLocks.length = 0

    // Assignment takes the general-admission subset; evacuation takes them all.
    await store.assign(identity)
    const generalLocks = probe.inventoryLocks.length
    await store.startEvacuation(identity, 'cell-b')

    expect(generalLocks).toBeGreaterThan(0)
    expect(probe.inventoryLocks.length).toBeGreaterThan(generalLocks)
    for (const options of probe.inventoryLocks) {
      const bounded = options?.lockTimeoutMs === CELL_INVENTORY_LOCK_TIMEOUT_MS
      expect(bounded || options?.failIfUnavailable === true).toBe(true)
    }
    await database.close()
  })

  // Why: evacuateDeadCells re-enters placement from a sweep. A 55P03 there would
  // be reported as a terminal sweep failure and freeze the incident gate.
  it('keeps the pool default when a sweep re-enters placement', async () => {
    const requestModes = await recordAssignInventoryModes(async (store) => {
      await store.assign(identity)
    })
    const sweepModes = await recordAssignInventoryModes(async (store) => {
      await store.assign(identity, undefined, undefined, 'pool-default')
    })

    // The inventory-first retry is the lane that carries the caller's mode.
    expect(requestModes).toContain(CELL_INVENTORY_LOCK_TIMEOUT_MS)
    expect(sweepModes).not.toContain(CELL_INVENTORY_LOCK_TIMEOUT_MS)
    expect(sweepModes.filter((mode) => mode === 'nowait').length).toBe(
      requestModes.filter((mode) => mode === 'nowait').length
    )
  })

  it('sends the sweep that re-enters placement down the unbounded lane', async () => {
    const database = await openInMemoryRelayDatabase()
    const probe = new InventoryLockProbe(database)
    let now = 1_000
    const store = new RelayAssignmentStore(probe, () => now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    await store.reconcileCells(CELLS)
    for (const cell of CELLS) {
      await store.recordCellHeartbeat({
        cellId: cell.id,
        cellUrl: cell.url,
        cellIncarnation: `1111111${cell.id.slice(-1)}-1111-4111-8111-111111111111`,
        startedAt: 50,
        ready: true,
        observedRequests: 0
      })
    }
    await store.assign(identity)
    // Let every heartbeat lapse so the sweep sees the assigned cell as dead.
    now += 45_001
    probe.inventoryLocks.length = 0
    probe.failActivityLockOnce = true

    await store.evacuateDeadCells()

    expect(probe.inventoryLocks).not.toEqual([])
    for (const options of probe.inventoryLocks) {
      expect(options?.lockTimeoutMs).toBeUndefined()
    }
    await database.close()
  })

  // Why: the SQLite hold test cannot reach PostgresDatabase.transaction, which is
  // the only path production ever takes.
  it('records the hold on the PostgreSQL transaction path', async () => {
    const database = await openFakePostgres()

    await database.transaction(async (transaction) => {
      await transaction.queryLocked(CELL_INVENTORY_SQL, [], {
        lockTimeoutMs: 150,
        measureHoldMs: true
      })
    })

    expect(consumeRelayCellInventoryHold(database).cellInventoryHolds).toBe(1)
    await database.close()
  })

  it('records no hold for a PostgreSQL transaction that took no measured lock', async () => {
    const database = await openFakePostgres()

    await database.transaction(async (transaction) => {
      await transaction.queryLocked(CELL_INVENTORY_SQL, [], { lockTimeoutMs: 150 })
    })

    expect(consumeRelayCellInventoryHold(database).cellInventoryHolds).toBe(0)
    await database.close()
  })

  // Why: index.ts boots a server on import, so its wiring can only be read. An
  // unspread hold metric is invisible: the flush simply omits the fields.
  it('spreads the hold counts into the runtime metrics flush', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    const flush = /observability\.start\(\(\) => \(\{([^}]*)\}\)\)/.exec(source)

    expect(flush?.[1]).toContain('...consumeRelayCellInventoryHold(database)')
  })

  // Why: 500ms is a first value, not a measurement. Tuning it needs the hold
  // distribution, which no runtime metric carried.
  it('reports how long the inventory lock was held to COMMIT', async () => {
    const database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, () => 1_000)
    await store.reconcileCells(CELLS)
    consumeRelayCellInventoryHold(database)

    await store.assign(identity)

    const counts = consumeRelayCellInventoryHold(database)
    expect(counts.cellInventoryHolds).toBeGreaterThan(0)
    expect(counts.cellInventoryHoldMsMax).toBeGreaterThanOrEqual(counts.cellInventoryHoldMsP95)
    expect(counts.cellInventoryHoldMsMax).toBeGreaterThan(0)
    // Consuming resets the window so the next flush reports its own holds.
    expect(consumeRelayCellInventoryHold(database).cellInventoryHolds).toBe(0)
    await database.close()
  })
})

// Why: exhausted transactions count against the incident monitor's bounded bar.
// A sweep that steps aside must not spend the retry budget or report a terminal failure.
describe('sweep lock skips stay off the transaction retry counters', () => {
  it('reports neither a retry nor an exhaustion when NOWAIT finds the lock held', async () => {
    const database = await openFakePostgres()
    fakes.query.mockImplementation(async (sql: string) => {
      fakes.statements.push(sql)
      if (sql.includes('FOR UPDATE NOWAIT')) {
        throw Object.assign(new Error('could not obtain lock'), { code: '55P03' })
      }
      return { rows: [], rowCount: 0 }
    })
    const events: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      try {
        events.push(String((JSON.parse(line as string) as { event?: unknown }).event))
      } catch {
        // non-JSON lines are not transaction telemetry
      }
    })

    try {
      await expect(
        database.transaction(async (transaction) => {
          await transaction.queryLocked(CELL_INVENTORY_SQL, [], { failIfUnavailable: true })
        })
      ).rejects.toThrow('database_lock_unavailable')
    } finally {
      warn.mockRestore()
    }

    expect(events).not.toContain('orca_relay_postgres_transaction_retry')
    expect(events).not.toContain('orca_relay_postgres_transaction_exhausted')
    expect(fakes.statements.filter((sql) => sql === 'BEGIN')).toHaveLength(1)
    await database.close()
  })
})

describe('background sweeps skip a contended cell inventory', () => {
  it('takes the inventory NOWAIT and skips the tick instead of queueing', async () => {
    const database = await openInMemoryRelayDatabase()
    const probe = new InventoryLockProbe(database)
    let now = 1_000
    const store = new RelayAssignmentStore(probe, () => now)
    await store.reconcileCells(CELLS)
    const assignment = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: assignment.cellId,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    await store.startEvacuation(identity, 'cell-b')
    now += 24 * 60 * 60_000
    probe.inventoryLocks.length = 0
    probe.failNoWait = true
    const warnings = collectWarnings('orca_relay_sweep_cell_inventory_busy')

    let aborted: number
    try {
      aborted = await store.abortExpiredEvacuations()
    } finally {
      warnings.restore()
    }

    expect(aborted).toBe(0)
    expect(probe.inventoryLocks).not.toEqual([])
    expect(probe.inventoryLocks.every((options) => options?.failIfUnavailable === true)).toBe(
      true
    )
    expect(warnings.entries).toEqual([
      { event: 'orca_relay_sweep_cell_inventory_busy', sweep: 'abort-expired-evacuations', skipped: 1 }
    ])
    await database.close()
  })

  // Why: a summary line on every quiet tick would bury the contended ones.
  it('says nothing on a tick that skipped no candidate', async () => {
    const database = await openInMemoryRelayDatabase()
    let now = 1_000
    const store = new RelayAssignmentStore(database, () => now)
    await store.reconcileCells(CELLS)
    const assignment = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: assignment.cellId,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    await store.startEvacuation(identity, 'cell-b')
    now += 24 * 60 * 60_000
    const warnings = collectWarnings('orca_relay_sweep_cell_inventory_busy')

    let aborted: number
    try {
      aborted = await store.abortExpiredEvacuations()
    } finally {
      warnings.restore()
    }

    expect(aborted).toBe(1)
    expect(warnings.entries).toEqual([])
    await database.close()
  })

  it('still aborts the expired evacuation once the inventory is free', async () => {
    const database = await openInMemoryRelayDatabase()
    const probe = new InventoryLockProbe(database)
    let now = 1_000
    const store = new RelayAssignmentStore(probe, () => now)
    await store.reconcileCells(CELLS)
    const assignment = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: assignment.cellId,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    await store.startEvacuation(identity, 'cell-b')
    now += 24 * 60 * 60_000

    expect(await store.abortExpiredEvacuations()).toBe(1)
    await database.close()
  })
})

// Returns each inventory lock the run took, as its bound or 'nowait'.
async function recordAssignInventoryModes(
  drive: (store: InstanceType<typeof RelayAssignmentStore>) => Promise<void>
): Promise<(number | 'nowait' | 'pool-default')[]> {
  const database = await openInMemoryRelayDatabase()
  const probe = new InventoryLockProbe(database)
  const store = new RelayAssignmentStore(probe, () => 1_000)
  await store.reconcileCells(CELLS)
  probe.inventoryLocks.length = 0
  probe.failActivityLockOnce = true
  await drive(store)
  await database.close()
  return probe.inventoryLocks.map((options) =>
    options?.failIfUnavailable ? 'nowait' : (options?.lockTimeoutMs ?? 'pool-default')
  )
}

function collectWarnings(event: string) {
  const entries: Record<string, unknown>[] = []
  const original = console.warn
  console.warn = (line: unknown, ...rest: unknown[]) => {
    try {
      const parsed = JSON.parse(line as string) as Record<string, unknown>
      if (parsed.event === event) return void entries.push(parsed)
    } catch {
      // fall through to the real console for non-JSON lines
    }
    original(line, ...rest)
  }
  return { entries, restore: () => (console.warn = original) }
}

const ACTIVITY_LEASE_SQL = 'SELECT * FROM relay_assignment_activity_leases'

class InventoryLockProbe implements RelayDatabase {
  readonly inventoryLocks: (RelayLockOptions | undefined)[] = []
  failNoWait = false
  // Forces the next assign attempt down its inventory-first retry, the only lane
  // that reaches the threaded lock mode.
  failActivityLockOnce = false

  constructor(private readonly delegate: RelayDatabase) {}

  async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    return await this.delegate.query(sql, params)
  }

  async queryLocked(
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]> {
    if (locksCellInventory(sql)) {
      this.inventoryLocks.push(options)
      if (this.failNoWait && options?.failIfUnavailable) {
        throw new Error('database_lock_unavailable')
      }
    }
    if (this.failActivityLockOnce && sql.trim().startsWith(ACTIVITY_LEASE_SQL) && options?.failIfUnavailable) {
      this.failActivityLockOnce = false
      throw new Error('database_lock_unavailable')
    }
    return await this.delegate.queryLocked(sql, params, options)
  }

  async transaction<T>(
    operation: (transaction: RelayDatabase) => Promise<T>,
    options?: RelayTransactionOptions
  ): Promise<T> {
    return await this.delegate.transaction(
      async (transaction) => await operation(new InventoryLockProbeTransaction(transaction, this)),
      options
    )
  }

  async close(): Promise<void> {}
}

class InventoryLockProbeTransaction implements RelayDatabase {
  constructor(
    private readonly delegate: RelayDatabase,
    private readonly probe: InventoryLockProbe
  ) {}

  async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    return await this.delegate.query(sql, params)
  }

  async queryLocked(
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]> {
    if (locksCellInventory(sql)) {
      this.probe.inventoryLocks.push(options)
      if (this.probe.failNoWait && options?.failIfUnavailable) {
        throw new Error('database_lock_unavailable')
      }
    }
    if (
      this.probe.failActivityLockOnce &&
      sql.trim().startsWith(ACTIVITY_LEASE_SQL) &&
      options?.failIfUnavailable
    ) {
      this.probe.failActivityLockOnce = false
      throw new Error('database_lock_unavailable')
    }
    return await this.delegate.queryLocked(sql, params, options)
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    return await operation(this)
  }

  async close(): Promise<void> {}
}
