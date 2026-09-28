import { describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayDatabase, RelayLockOptions, SqlRow } from './database.js'
import { openInMemoryRelayDatabase } from './database.js'

const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
const activityId = 'splice:connection-1'

class LockOrderDatabase implements RelayDatabase {
  readonly lockedTables: string[] = []

  constructor(
    private readonly cleanupCandidate: boolean,
    private readonly currentLeaseExpiresAt: number,
    private readonly activityLeasePresent = true
  ) {}

  async query(sql: string): Promise<SqlRow[]> {
    if (sql.includes('SELECT user_id, relay_host_id, activity_id')) {
      return this.cleanupCandidate
        ? [
            {
              user_id: identity.userId,
              relay_host_id: identity.relayHostId,
              activity_id: activityId
            }
          ]
        : []
    }
    if (
      sql.includes('UPDATE relay_cells SET reserved_requests') &&
      sql.includes('RETURNING cell_id')
    ) {
      this.lockedTables.push('cell')
      return [{ cell_id: 'cell-a' }]
    }
    return [{ changes: 1 }]
  }

  async queryLocked(sql: string): Promise<SqlRow[]> {
    if (sql.includes('FROM relay_assignments ')) {
      this.lockedTables.push('assignment')
      return [{ cell_id: 'cell-a', assignment_epoch: 1 }]
    }
    if (sql.includes('FROM relay_assignment_activity_leases')) {
      this.lockedTables.push('activity')
      if (!this.activityLeasePresent) return []
      return [
        {
          user_id: identity.userId,
          relay_host_id: identity.relayHostId,
          activity_id: activityId,
          activity_kind: 'splice',
          cell_id: 'cell-a',
          request_units: 2,
          expires_at: this.currentLeaseExpiresAt
        }
      ]
    }
    if (sql.trim() === 'SELECT * FROM relay_cells ORDER BY cell_id ASC') {
      this.lockedTables.push('cell-inventory')
      return [{ cell_id: 'cell-a', reserved_requests: 3, capacity_requests: 10 }]
    }
    if (sql.includes('FROM relay_cells')) {
      this.lockedTables.push('cell')
      return [{ reserved_requests: 3, capacity_requests: 10 }]
    }
    return []
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    return await operation(this)
  }

  async close(): Promise<void> {}
}

class ReassignmentLockOrderDatabase implements RelayDatabase {
  readonly locks: string[] = []

  async query(sql: string): Promise<SqlRow[]> {
    if (sql.includes('SELECT cell_id, region FROM relay_cell_regions')) {
      return ['cell-a', 'cell-b'].map((cell_id) => ({ cell_id, region: 'us-central1' }))
    }
    if (sql.includes('SELECT region FROM relay_cell_regions')) {
      return [{ region: 'us-central1' }]
    }
    if (sql.includes('SELECT * FROM relay_cells WHERE cell_id')) {
      return [cellRow('cell-b', 1)]
    }
    if (sql.includes('JOIN relay_cell_runtime') && sql.includes('cell.cell_id = ?')) {
      return []
    }
    if (sql.includes('SELECT cell_id, observed_requests FROM relay_cell_runtime')) {
      return [{ cell_id: 'cell-a', observed_requests: 0 }]
    }
    if (sql.includes('LEFT JOIN relay_cell_admission')) {
      return [
        { cell_id: 'cell-a', admission_state: 'general' },
        { cell_id: 'cell-b', admission_state: 'general' }
      ]
    }
    if (sql.includes('FROM relay_cell_connection_limits')) return []
    return [{ changes: 1 }]
  }

  async queryLocked(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    if (sql.includes('FROM relay_assignments')) {
      this.locks.push('assignment')
      return [
        {
          user_id: identity.userId,
          relay_host_id: identity.relayHostId,
          cell_id: 'cell-b',
          assignment_epoch: 1,
          lease_expires_at: 100,
          last_activity_at: 100,
          reserved_controls: 0,
          reserved_splices: 0,
          reserved_invites: 0,
          pending_installs: 0,
          pending_confirmations: 0,
          migration_leases: 0
        }
      ]
    }
    if (sql.trim() === 'SELECT * FROM relay_cells ORDER BY cell_id ASC') {
      this.locks.push('cell-inventory')
      return [cellRow('cell-a', 0), cellRow('cell-b', 1)]
    }
    if (sql.includes('SELECT * FROM relay_cells WHERE cell_id')) {
      const cellId = String(params[0])
      this.locks.push(cellId)
      return [cellRow(cellId, cellId === 'cell-b' ? 1 : 0)]
    }
    return []
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    return await operation(this)
  }

  async close(): Promise<void> {}
}

class AggregateCleanupDatabase implements RelayDatabase {
  failIfUnavailable: boolean | null = null

  async query(): Promise<SqlRow[]> {
    return [{ changes: 1 }]
  }

  async queryLocked(
    sql: string,
    _params: unknown[] = [],
    options: RelayLockOptions = {}
  ): Promise<SqlRow[]> {
    if (sql.includes('FROM relay_assignments WHERE lease_expires_at')) {
      this.failIfUnavailable = options.failIfUnavailable ?? false
    }
    return []
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    return await operation(this)
  }

  async close(): Promise<void> {}
}

class HeartbeatLockDatabase implements RelayDatabase {
  readonly locks: string[] = []
  readonly reservationCleanupTransactions: number[] = []
  legacyHeartbeatWritten = false
  private transactionNumber = 0
  private activeTransaction = 0

  constructor(
    private readonly cleanupIncarnation = '11111111-1111-4111-8111-111111111111'
  ) {}

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    if (sql.includes('SELECT region FROM relay_cell_regions')) {
      return [{ cell_id: String(params[0]), region: 'us-central1' }]
    }
    if (sql.includes('SELECT * FROM relay_cells WHERE cell_id')) {
      return [cellRow('cell-a', 0)]
    }
    if (sql.includes('UPDATE relay_cells SET observed_requests')) {
      this.legacyHeartbeatWritten = true
    }
    if (sql.includes('UPDATE relay_control_connection_reservations')) {
      this.reservationCleanupTransactions.push(this.activeTransaction)
    }
    return [{ changes: 1 }]
  }

  async queryLocked(sql: string): Promise<SqlRow[]> {
    if (sql.includes('FROM relay_cells')) {
      this.locks.push('cell')
      return [cellRow('cell-a', 0)]
    }
    if (sql.includes('FROM relay_cell_runtime')) {
      this.locks.push('runtime')
      return this.activeTransaction === 2
        ? [{ cell_incarnation: this.cleanupIncarnation }]
        : []
    }
    if (sql.includes('FROM relay_cell_connection_limits')) {
      this.locks.push('connection-limit')
      return [{ hard_cap: 600, unobserved_bound: 99 }]
    }
    if (sql.includes('FROM relay_cell_connection_snapshots')) {
      this.locks.push('snapshot')
      return this.activeTransaction === 2
        ? [{ cell_incarnation: this.cleanupIncarnation, inclusion_watermark: 0 }]
        : []
    }
    return []
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    this.activeTransaction = ++this.transactionNumber
    const result = await operation(this)
    this.activeTransaction = 0
    return result
  }

  async close(): Promise<void> {}
}

class NewAssignmentLockDatabase implements RelayDatabase {
  readonly inventoryLocks: string[] = []
  private generalLockFailed = false

  constructor(
    private failGeneralOnce = false,
    private readonly assignmentAppearsAfterFailure = false
  ) {}

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    if (sql.includes('SELECT cell_id, region FROM relay_cell_regions')) {
      return [
        { cell_id: 'cell-existing', region: 'us-central1' },
        { cell_id: 'cell-general', region: 'us-central1' }
      ]
    }
    if (sql.includes('SELECT region FROM relay_cell_regions')) {
      return [{ cell_id: String(params[0]), region: 'us-central1' }]
    }
    if (sql.includes('SELECT cell_id, observed_requests FROM relay_cell_runtime')) {
      return [{ cell_id: 'cell-general', observed_requests: 0 }]
    }
    if (sql.includes('LEFT JOIN relay_cell_admission')) {
      return [{ cell_id: 'cell-general', admission_state: 'general' }]
    }
    if (sql.includes('JOIN relay_cell_runtime') && sql.includes('cell.cell_id = ?')) {
      return [{ cell_id: 'cell-existing' }]
    }
    if (sql.includes('FROM relay_cell_connection_limits')) {
      return [
        {
          cell_id: 'cell-general',
          hard_cap: 600,
          unobserved_bound: 99,
          enforced_connection_units: 0,
          outstanding_reservations: 0,
          last_heartbeat_at: 100,
          connection_incarnation: 'incarnation-a',
          current_incarnation: 'incarnation-a'
        }
      ]
    }
    return [{ changes: 1 }]
  }

  async queryLocked(sql: string): Promise<SqlRow[]> {
    if (
      sql.includes('FROM relay_assignments') &&
      this.assignmentAppearsAfterFailure &&
      this.generalLockFailed
    ) {
      return [
        {
          user_id: identity.userId,
          relay_host_id: identity.relayHostId,
          cell_id: 'cell-existing',
          assignment_epoch: 1,
          lease_expires_at: 100,
          last_activity_at: 100,
          reserved_controls: 1,
          reserved_splices: 0,
          reserved_invites: 0,
          pending_installs: 0,
          pending_confirmations: 0,
          migration_leases: 0
        }
      ]
    }
    if (sql.includes('SELECT cell_id FROM relay_cell_admission')) {
      this.inventoryLocks.push('general')
      if (this.failGeneralOnce) {
        this.failGeneralOnce = false
        this.generalLockFailed = true
        throw new Error('database_lock_unavailable')
      }
      return [cellRow('cell-general', 0)]
    }
    if (sql.trim() === 'SELECT * FROM relay_cells ORDER BY cell_id ASC') {
      this.inventoryLocks.push('all')
      return [cellRow('cell-existing', 0), cellRow('cell-general', 0)]
    }
    if (sql.includes('SELECT * FROM relay_cells WHERE cell_id')) {
      return [cellRow('cell-general', 0)]
    }
    return []
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    return await operation(this)
  }

  async close(): Promise<void> {}
}

function cellRow(cellId: string, reservedRequests: number): SqlRow {
  return {
    cell_id: cellId,
    cell_url: `https://${cellId}.example.com`,
    enabled: 1,
    capacity_requests: 10,
    reserved_requests: reservedRequests,
    observed_requests: 0
  }
}

describe('RelayAssignmentStore activity lock order', () => {
  it('updates the cell only after assignment activity during release', async () => {
    const database = new LockOrderDatabase(false, 100)
    const store = new RelayAssignmentStore(database, () => 100)

    await expect(store.releaseActivity(identity, activityId)).resolves.toBe(true)
    expect(database.lockedTables).toEqual(['assignment', 'activity', 'cell'])
  })

  it('updates the cell only after inserting new activity', async () => {
    const database = new LockOrderDatabase(false, 100, false)
    const store = new RelayAssignmentStore(database, () => 100)

    await expect(
      store.acquireActivity(identity, { activityId, kind: 'splice', cellId: 'cell-a' })
    ).resolves.toBeUndefined()
    expect(database.lockedTables).toEqual(['assignment', 'activity', 'cell'])
  })

  it('rechecks an expired candidate after taking the assignment lock', async () => {
    const database = new LockOrderDatabase(true, 101)
    const store = new RelayAssignmentStore(database, () => 100)

    await expect(store.releaseExpiredActivityLeases()).resolves.toBe(0)
    expect(database.lockedTables).toEqual(['assignment', 'activity'])
  })

  it('fails fast before aggregate cleanup waits on mixed-version assignment rows', async () => {
    const database = new AggregateCleanupDatabase()
    const store = new RelayAssignmentStore(database, () => 100)

    await expect(store.releaseExpiredActivity()).resolves.toBe(0)
    expect(database.failIfUnavailable).toBe(true)
  })

  it('releases the placement capacity lock before heartbeat reservation cleanup', async () => {
    const database = new HeartbeatLockDatabase()
    const store = new RelayAssignmentStore(database, () => 100, { requireLiveCells: true })

    await store.recordCellHeartbeat({
      cellId: 'cell-a',
      cellUrl: 'https://cell-a.example.com',
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 0,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 0,
      connectionHardCap: 600,
      connectionUnobservedBound: 99
    })

    expect(database.locks).toEqual([
      'cell',
      'runtime',
      'connection-limit',
      'snapshot',
      'runtime',
      'snapshot'
    ])
    expect(database.legacyHeartbeatWritten).toBe(false)
    expect(database.reservationCleanupTransactions).toEqual([2, 2, 2])
  })

  it('does not let an old heartbeat clean replacement-incarnation reservations', async () => {
    const database = new HeartbeatLockDatabase('22222222-2222-4222-8222-222222222222')
    const store = new RelayAssignmentStore(database, () => 100, { requireLiveCells: true })

    await store.recordCellHeartbeat({
      cellId: 'cell-a',
      cellUrl: 'https://cell-a.example.com',
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 0,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 0,
      connectionHardCap: 600,
      connectionUnobservedBound: 99
    })

    expect(database.reservationCleanupTransactions).toEqual([])
  })

  it('locks only general-admission inventory for a brand-new assignment', async () => {
    const database = new NewAssignmentLockDatabase()
    const store = new RelayAssignmentStore(database, () => 100, {
      requireLiveCells: true,
      heartbeatTtlMs: 45
    })

    await expect(store.assign(identity)).resolves.toMatchObject({
      cellId: 'cell-general',
      assignmentEpoch: 1
    })
    expect(database.inventoryLocks).toEqual(['general'])
  })

  it('keeps a brand-new assignment retry scoped to general admission', async () => {
    const database = new NewAssignmentLockDatabase(true)
    const store = new RelayAssignmentStore(database, () => 100, {
      requireLiveCells: true,
      heartbeatTtlMs: 45
    })

    await expect(store.assign(identity)).resolves.toMatchObject({
      cellId: 'cell-general',
      assignmentEpoch: 1
    })
    expect(database.inventoryLocks).toEqual(['general', 'general'])
  })

  it('restarts with full inventory if an assignment appears during a general retry', async () => {
    const database = new NewAssignmentLockDatabase(true, true)
    const store = new RelayAssignmentStore(database, () => 100, {
      requireLiveCells: true,
      heartbeatTtlMs: 45
    })

    await expect(store.assign(identity)).resolves.toMatchObject({
      cellId: 'cell-existing',
      assignmentEpoch: 1
    })
    expect(database.inventoryLocks).toEqual(['general', 'general', 'all'])
  })

  it('probes the sticky cell before locking full inventory for dead-cell reassignment', async () => {
    const database = new ReassignmentLockOrderDatabase()
    const store = new RelayAssignmentStore(database, () => 100, {
      requireLiveCells: true,
      heartbeatTtlMs: 45
    })

    await expect(store.assign(identity)).resolves.toMatchObject({
      cellId: 'cell-a',
      assignmentEpoch: 2
    })
    expect(database.locks).toEqual([
      'assignment',
      'cell-b',
      'assignment',
      'cell-inventory',
      'cell-b',
      'cell-a'
    ])
  })
})

const TARGET_ROW_LOCK = 'FOR UPDATE OF cell, admission NOWAIT'

type RecordedStatement = { sql: string; locked: boolean; options?: RelayLockOptions }

// Reports Postgres (or no dialect) so the store emits its real lock clause,
// and strips that clause before SQLite runs the statement.
function recordAsPostgres(
  database: RelayDatabase,
  statements: RecordedStatement[],
  dialect: 'postgres' | 'omitted'
): RelayDatabase {
  const decorate = (delegate: RelayDatabase): RelayDatabase => ({
    ...(dialect === 'postgres' ? { dialect } : {}),
    query: async (sql, params) => {
      statements.push({ sql, locked: false })
      return await delegate.query(sql, params)
    },
    queryLocked: async (sql, params, options) => {
      statements.push({ sql, locked: true, options })
      return await delegate.queryLocked(sql.replace(TARGET_ROW_LOCK, ''), params, options)
    },
    transaction: async (operation, options) =>
      await delegate.transaction(async (transaction) => await operation(decorate(transaction)), options),
    close: async () => await delegate.close()
  })
  return decorate(database)
}

async function idleRehomeCommitStatements(dialect: 'postgres' | 'omitted' = 'postgres'): Promise<{
  outcome: string
  statements: RecordedStatement[]
}> {
  const sqlite = await openInMemoryRelayDatabase()
  const statements: RecordedStatement[] = []
  let recording = false
  const recorded = recordAsPostgres(sqlite, statements, dialect)
  let now = 100_000_000
  const plain = new RelayAssignmentStore(sqlite, () => now, { regionalRehomeCohortPercent: 100 })
  const store = new RelayAssignmentStore(
    {
      ...recorded,
      transaction: async (operation, options) =>
        recording
          ? await recorded.transaction(operation, options)
          : await sqlite.transaction(operation, options)
    },
    () => now,
    { regionalRehomeCohortPercent: 100 }
  )
  await plain.inspectRegionalRehomeControl()
  now += 86_400_000
  await plain.applyRegionalRehomeControl({
    expectedGeneration: 0,
    enabled: true,
    notBefore: now,
    ratePerMinute: 10,
    preferenceMaxAgeMs: 86_400_000,
    hostCooldownMs: 604_800_000,
    drainGraceMs: 60_000
  })
  const cells = [
    { id: 'source', url: 'https://source.example.test', region: 'asia-east2' as const, capacityRequests: 100 },
    { id: 'target', url: 'https://target.example.test', region: 'us-central1' as const, capacityRequests: 100 }
  ]
  const incarnations = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
  const safety = {
    observedAt: now,
    sqlFailures: 0,
    reconnects: 0,
    controlActivityRecoveryFailures: 0,
    databasePoolWaiting: 0,
    databasePoolWaitersMax: 0,
    databasePoolWaitMsMax: 0
  }
  await plain.reconcileCells(cells)
  for (const [index, cell] of cells.entries()) {
    await plain.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      region: cell.region,
      cellIncarnation: incarnations[index]!,
      startedAt: now - 1_000,
      ready: true,
      observedRequests: 0
    })
    await plain.recordCellRegionalRehomeStatus({
      cellId: cell.id,
      cellIncarnation: incarnations[index]!,
      regionalRehomeProtocol: 3,
      safety
    })
  }
  const assignment = await plain.assign(identity, undefined, 'asia-east2')
  await plain.activateControl(identity, {
    cellId: 'source',
    assignmentEpoch: assignment.assignmentEpoch,
    generation: 7,
    cellIncarnation: incarnations[0],
    idleRegionalRehome: true
  })
  const issued = await plain.exchangeRegionCorrection(
    identity,
    { v: 1, action: 'issue-window' },
    assignment.assignmentEpoch
  )
  await plain.exchangeRegionCorrection(
    identity,
    {
      v: 1,
      action: 'report',
      generation: issued.window!.generation,
      assignmentEpoch: assignment.assignmentEpoch,
      policyVersion: 1,
      outcome: 'conclusive',
      measurements: { 'us-central1': 40, 'asia-east2': 180 }
    },
    assignment.assignmentEpoch
  )
  const [request] = await plain.selectIdleRegionalRehomeCandidates(safety)
  expect(request).toMatchObject({ sourceCellId: 'source', targetCellId: 'target' })
  recording = true
  const result = await store.commitIdleRegionalRehome(request!, safety)
  recording = false
  await sqlite.close()
  return { outcome: result.outcome, statements }
}

function lockedTable(statement: RecordedStatement): string {
  return /\bFROM\s+(\w+)/.exec(statement.sql)?.[1] ?? '?'
}

// The rehome commit takes the host's assignment row before any cell row, the
// reverse of placement (cells, then assignment). That is deadlock-free only
// because its one cell lock never waits.
describe('RelayAssignmentStore idle rehome commit lock order', () => {
  it('locks host rows first and the target cell row last, NOWAIT, with no fleet-wide lock', async () => {
    const { outcome, statements } = await idleRehomeCommitStatements()
    expect(outcome).toBe('committed')
    // The commit transaction is everything after the reconcile transaction's
    // attempt read, which is the first statement touching the control row.
    const commit = statements.slice(
      statements.findIndex((statement) => statement.sql.includes('relay_region_rehome_control'))
    )
    const locked = commit.filter((statement) => statement.locked)

    expect(locked.map(lockedTable)).toEqual([
      'relay_region_rehome_control',
      'relay_region_rehome_worker_state',
      'relay_assignments',
      'relay_region_decisions',
      'relay_assignment_migrations',
      'relay_assignment_activity_leases',
      'relay_control_connection_reservations',
      // insertControlConnectionReservation re-reads the host's rows locked.
      'relay_control_connection_reservations',
      'relay_cells'
    ])
    // Control and worker rows serialise the budget and hard-cap reads; they
    // must refuse rather than queue behind another cross-region commit.
    expect(locked.slice(0, 2).map((statement) => statement.options?.failIfUnavailable)).toEqual([
      true,
      true
    ])
    const target = locked[locked.length - 1]!
    expect(commit[commit.length - 1]).toBe(target)
    expect(target.sql).toContain(TARGET_ROW_LOCK)
    expect(target.sql).toMatch(/WHERE cell\.cell_id = \?/)
    expect(target.options).toMatchObject({
      failIfUnavailable: true,
      lockClauseInStatement: true,
      measureHoldMs: true,
      holdSite: 'rehome-target-row'
    })
    expect(
      commit.filter((statement) =>
        /FROM relay_cell(s|_runtime|_capabilities|_rehome_safety)\b/.test(statement.sql) &&
        statement !== target &&
        (statement.locked || /FOR UPDATE/.test(statement.sql))
      )
    ).toEqual([])
  })
  // Why: dialect is optional, and a wrapper that omits it must not silently
  // run the target-row write unlocked and without NOWAIT.
  it('keeps the target-row lock clause when a wrapper omits the dialect', async () => {
    const { outcome, statements } = await idleRehomeCommitStatements('omitted')
    expect(outcome).toBe('committed')
    const target = statements.filter((statement) => statement.sql.includes('WITH target AS'))

    expect(target).toHaveLength(1)
    expect(target[0]!.sql).toContain(TARGET_ROW_LOCK)
  })
})
