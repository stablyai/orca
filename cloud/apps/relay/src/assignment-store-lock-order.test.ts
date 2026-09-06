import { describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayDatabase, RelayLockOptions, SqlRow } from './database.js'

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
