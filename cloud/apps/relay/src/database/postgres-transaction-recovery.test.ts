import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from '../assignment/assignment-store.js'
import {
  openRelayDatabase,
  type RelayDatabase,
  type RelayLockOptions,
  type SqlRow
} from './database.js'

function postgresTestDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const url = new URL(value)
  // Detect the intended deadlock before the one-second runtime lock deadline.
  url.searchParams.set('options', '-c deadlock_timeout=100ms')
  return url.toString()
}

const databaseUrl = postgresTestDatabaseUrl(process.env.ORCA_RELAY_TEST_POSTGRES_URL)
const describePostgres = databaseUrl ? describe : describe.skip

type QueryLockHook = (phase: 'before' | 'after', sql: string) => Promise<void>

class TransactionProbeDatabase implements RelayDatabase {
  constructor(
    private readonly database: RelayDatabase,
    private readonly hook: QueryLockHook
  ) {}

  async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    return await this.database.query(sql, params)
  }

  async queryLocked(
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]> {
    return await this.database.queryLocked(sql, params, options)
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    return await this.database.transaction(async (transaction) => {
      return await operation(
        new QueryLockProbeTransaction(transaction, this.hook)
      )
    })
  }

  async close(): Promise<void> {}
}

class QueryLockProbeTransaction implements RelayDatabase {
  constructor(
    private readonly transactionDatabase: RelayDatabase,
    private readonly hook: QueryLockHook
  ) {}

  async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    const rows = await this.transactionDatabase.query(sql, params)
    return rows
  }

  async queryLocked(
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]> {
    await this.hook('before', sql)
    const rows = await this.transactionDatabase.queryLocked(sql, params, options)
    await this.hook('after', sql)
    return rows
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    return await operation(this)
  }

  async close(): Promise<void> {}
}

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => (resolve = done)), resolve }
}

describePostgres('PostgreSQL transaction recovery', () => {
  let database: RelayDatabase

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '' })
  })

  afterAll(async () => {
    await database.close()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const table of [
      'relay_assignment_migration_incarnations',
      'relay_control_connection_reservations'
    ]) {
      await database.query(`DELETE FROM ${table} WHERE user_id IN (?, ?)`, [
        'completion-race-user',
        'completion-contention-user'
      ])
    }
    for (const table of ['relay_cell_admission', 'relay_cell_regions']) {
      await database.query(`DELETE FROM ${table} WHERE cell_id IN (?, ?, ?, ?)`, [
        'completion-race-source',
        'completion-race-target',
        'completion-contention-source',
        'completion-contention-target'
      ])
    }
    for (const identity of [
      { userId: 'released-order-user', relayHostId: 'releasedorder001' },
      { userId: 'normalized-order-user', relayHostId: 'normalizedorder1' },
      { userId: 'atomic-final-user-a', relayHostId: 'atomicfinalhosta' },
      { userId: 'atomic-final-user-b', relayHostId: 'atomicfinalhostb' },
      { userId: 'lease-assignment-contention-user', relayHostId: 'leaseassignment1' }
    ]) {
      await database.query(
        `DELETE FROM relay_assignment_activity_leases WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
      await database.query(
        `DELETE FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    }
    await database.query(`DELETE FROM relay_cells WHERE cell_id IN (?, ?)`, [
      'released-order-cell',
      'normalized-order-cell'
    ])
    await database.query(`DELETE FROM relay_cells WHERE cell_id = ?`, ['atomic-final-cell'])
    await database.query(`DELETE FROM relay_cells WHERE cell_id = ?`, [
      'lease-assignment-contention-cell'
    ])
    await database.query(
      `DELETE FROM relay_assignment_activity_leases WHERE user_id LIKE 'reconcile-user-%'`
    )
    await database.query(`DELETE FROM relay_assignments WHERE user_id LIKE 'reconcile-user-%'`)
    await database.query(`DELETE FROM relay_cells WHERE cell_id IN (?, ?)`, [
      'reconcile-cell-a',
      'reconcile-cell-b'
    ])
    await database.query(
      `DELETE FROM relay_assignment_activity_leases WHERE user_id = ?`,
      ['completion-race-user']
    )
    await database.query(`DELETE FROM relay_assignment_migrations WHERE user_id = ?`, [
      'completion-race-user'
    ])
    await database.query(`DELETE FROM relay_assignments WHERE user_id = ?`, [
      'completion-race-user'
    ])
    await database.query(`DELETE FROM relay_cells WHERE cell_id IN (?, ?)`, [
      'completion-race-source',
      'completion-race-target'
    ])
    await database.query(
      `DELETE FROM relay_assignment_activity_leases WHERE user_id = ?`,
      ['completion-contention-user']
    )
    await database.query(`DELETE FROM relay_assignment_migrations WHERE user_id = ?`, [
      'completion-contention-user'
    ])
    await database.query(`DELETE FROM relay_assignments WHERE user_id = ?`, [
      'completion-contention-user'
    ])
    await database.query(`DELETE FROM relay_cell_runtime WHERE cell_id IN (?, ?)`, [
      'completion-contention-source',
      'completion-contention-target'
    ])
    await database.query(`DELETE FROM relay_cells WHERE cell_id IN (?, ?)`, [
      'completion-contention-source',
      'completion-contention-target'
    ])
    await database.query(`DELETE FROM relay_cell_fences WHERE cell_id = ?`, [
      'dead-source-contention-source'
    ])
    await database.query(
      `DELETE FROM relay_control_connection_reservations WHERE user_id = ?`,
      ['dead-source-contention-user']
    )
    await database.query(
      `DELETE FROM relay_assignment_activity_leases WHERE user_id = ?`,
      ['dead-source-contention-user']
    )
    await database.query(
      `DELETE FROM relay_assignment_migration_incarnations WHERE user_id = ?`,
      ['dead-source-contention-user']
    )
    await database.query(`DELETE FROM relay_assignment_migrations WHERE user_id = ?`, [
      'dead-source-contention-user'
    ])
    await database.query(`DELETE FROM relay_assignments WHERE user_id = ?`, [
      'dead-source-contention-user'
    ])
    await database.query(`DELETE FROM relay_cell_runtime WHERE cell_id IN (?, ?)`, [
      'dead-source-contention-source',
      'dead-source-contention-target'
    ])
    await database.query(`DELETE FROM relay_cell_admission WHERE cell_id IN (?, ?)`, [
      'dead-source-contention-source',
      'dead-source-contention-target'
    ])
    await database.query(`DELETE FROM relay_cells WHERE cell_id IN (?, ?)`, [
      'dead-source-contention-source',
      'dead-source-contention-target'
    ])
    await database.query(
      `DELETE FROM relay_assignment_activity_leases
       WHERE user_id IN (?, ?)`,
      ['lease-contention-user', 'aggregate-contention-user']
    )
    await database.query(
      `DELETE FROM relay_assignments
       WHERE user_id IN (?, ?)`,
      ['lease-contention-user', 'aggregate-contention-user']
    )
    await database.query(`DELETE FROM relay_cells WHERE cell_id IN (?, ?)`, [
      'lease-contention-cell',
      'aggregate-contention-cell'
    ])
    await database.query(
      `DELETE FROM relay_assignment_activity_leases WHERE user_id = ?`,
      ['sustained-lock-user']
    )
    await database.query(`DELETE FROM relay_assignments WHERE user_id = ?`, [
      'sustained-lock-user'
    ])
    await database.query(`DELETE FROM relay_cells WHERE cell_id = ?`, [
      'sustained-lock-cell'
    ])
    await database.query(
      `DELETE FROM relay_assignment_activity_leases WHERE user_id = ?`,
      ['sticky-cell-contention-user']
    )
    await database.query(
      `DELETE FROM relay_assignments WHERE user_id = ?`,
      ['sticky-cell-contention-user']
    )
    await database.query(`DELETE FROM relay_cells WHERE cell_id = ?`, [
      'sticky-cell-contention-cell'
    ])
    await database.query(
      `DELETE FROM relay_assignment_activity_leases WHERE user_id LIKE 'postgres-user-%'`
    )
    await database.query(`DELETE FROM relay_assignments WHERE user_id LIKE 'postgres-user-%'`)
    await database.query(`DELETE FROM relay_cells WHERE cell_id IN (?, ?, ?)`, [
      'cell-a',
      'cell-b',
      'cell-c'
    ])
    await database.query(
      `DELETE FROM relay_assignment_activity_leases WHERE user_id LIKE 'sticky-fast-user-%'`
    )
    await database.query(
      `DELETE FROM relay_assignments WHERE user_id LIKE 'sticky-fast-user-%'`
    )
    await database.query(`DELETE FROM relay_cells WHERE cell_id = ?`, [
      'sticky-fast-cell'
    ])
  })

  it('retries an entire deadlock victim transaction on a fresh attempt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const keys = ['deadlock-a', 'deadlock-b']
    for (const key of keys) {
      await database.query(
        `INSERT INTO relay_rate_windows
         (scope_key, window_kind, window_started_at, count) VALUES (?, ?, ?, ?)
         ON CONFLICT (scope_key, window_kind, window_started_at) DO UPDATE SET count = ?`,
        [key, 'transaction-recovery', 1, 0, 0]
      )
    }

    let firstAttemptArrivals = 0
    let releaseFirstAttempts!: () => void
    const firstAttemptsReady = new Promise<void>((resolve) => {
      releaseFirstAttempts = resolve
    })
    const attempts = [0, 0]
    const mutateWithOppositeLockOrder = async (
      operationIndex: number,
      firstKey: string,
      secondKey: string
    ): Promise<void> => {
      await database.transaction(async (transaction) => {
        attempts[operationIndex] = (attempts[operationIndex] ?? 0) + 1
        await transaction.queryLocked(
          `SELECT * FROM relay_rate_windows
           WHERE scope_key = ? AND window_kind = ? AND window_started_at = ?`,
          [firstKey, 'transaction-recovery', 1]
        )
        if (attempts[operationIndex] === 1) {
          firstAttemptArrivals++
          if (firstAttemptArrivals === 2) releaseFirstAttempts()
          await firstAttemptsReady
        }
        await transaction.queryLocked(
          `SELECT * FROM relay_rate_windows
           WHERE scope_key = ? AND window_kind = ? AND window_started_at = ?`,
          [secondKey, 'transaction-recovery', 1]
        )
        await transaction.query(
          `UPDATE relay_rate_windows SET count = count + 1
           WHERE scope_key = ? AND window_kind = ? AND window_started_at = ?`,
          [firstKey, 'transaction-recovery', 1]
        )
      })
    }

    await Promise.all([
      mutateWithOppositeLockOrder(0, keys[0]!, keys[1]!),
      mutateWithOppositeLockOrder(1, keys[1]!, keys[0]!)
    ])

    const rows = await database.query(
      `SELECT scope_key, count FROM relay_rate_windows
       WHERE window_kind = ? ORDER BY scope_key`,
      ['transaction-recovery']
    )
    expect(rows).toEqual([
      { scope_key: keys[0], count: '1' },
      { scope_key: keys[1], count: '1' }
    ])
    warn.mockRestore()
  }, 10_000)

  it('keeps a unit placed between reconciliation reading leases and locking cells', async () => {
    const now = 1_350_000_000_000
    const cells = [
      { id: 'reconcile-cell-a', url: 'https://reconcile-a.example.com', capacityRequests: 100 },
      { id: 'reconcile-cell-b', url: 'https://reconcile-b.example.com', capacityRequests: 100 }
    ]
    const seedStore = new RelayAssignmentStore(database, () => now)
    await seedStore.reconcileCells(cells)

    const leasesRead = signal()
    const continueReconciliation = signal()
    let gateReconciliation = true
    const reconcileDatabase = new TransactionProbeDatabase(database, async (phase, sql) => {
      if (
        gateReconciliation &&
        phase === 'after' &&
        sql.includes('SELECT lease.* FROM relay_assignment_activity_leases lease')
      ) {
        gateReconciliation = false
        leasesRead.resolve()
        await continueReconciliation.promise
      }
    })
    const reconciliation = new RelayAssignmentStore(
      reconcileDatabase,
      () => now
    ).cellEvacuationStatus('reconcile-cell-a', 'reconcile-cell-b', true)
    await leasesRead.promise
    // A brand-new host holds no row reconciliation locked, so it commits in the gap.
    const grant = await seedStore.assign({
      userId: 'reconcile-user-gap',
      relayHostId: 'reconcilehostgap'
    })
    continueReconciliation.resolve()
    await reconciliation

    expect(['reconcile-cell-a', 'reconcile-cell-b']).toContain(grant.cellId)
    const reservations = await database.query(
      `SELECT cell.cell_id, cell.reserved_requests,
         COALESCE(SUM(lease.request_units), 0) AS lease_units
       FROM relay_cells cell
       LEFT JOIN relay_assignment_activity_leases lease ON lease.cell_id = cell.cell_id
       WHERE cell.cell_id = ?
       GROUP BY cell.cell_id, cell.reserved_requests`,
      [grant.cellId]
    )
    expect(reservations).toEqual([
      { cell_id: grant.cellId, reserved_requests: '1', lease_units: '1' }
    ])
  }, 15_000)

  it('fences a source activity queued behind evacuation completion', async () => {
    const now = 1_400_000_000_000
    const identity = {
      userId: 'completion-race-user',
      relayHostId: 'completionrace01'
    }
    const sourceCellId = 'completion-race-source'
    const targetCellId = 'completion-race-target'
    const seedStore = new RelayAssignmentStore(database, () => now)
    await seedStore.reconcileCells([
      {
        id: sourceCellId,
        url: 'https://completion-source.example.com',
        capacityRequests: 100
      },
      {
        id: targetCellId,
        url: 'https://completion-target.example.com',
        capacityRequests: 100
      }
    ])
    const assignment = await seedStore.assign(identity)
    const sourceControl = await seedStore.activateControl(identity, {
      cellId: sourceCellId,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    const migration = await seedStore.startEvacuation(identity, targetCellId)
    await seedStore.activateControl(identity, {
      cellId: targetCellId,
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await seedStore.markMigrationTargetRegistered(identity, {
      cellId: targetCellId,
      assignmentEpoch: migration.assignmentEpoch
    })
    await seedStore.releaseActivity(identity, sourceControl)

    const assignmentLocked = signal()
    const activityReachedAssignment = signal()
    const continueCompletion = signal()
    let gateCompletion = true
    const completionDatabase = new TransactionProbeDatabase(database, async (phase, sql) => {
      if (
        gateCompletion &&
        phase === 'after' &&
        sql.includes('FROM relay_assignments WHERE user_id')
      ) {
        gateCompletion = false
        assignmentLocked.resolve()
        await continueCompletion.promise
      }
    })
    const activityDatabase = new TransactionProbeDatabase(database, async (phase, sql) => {
      if (phase === 'before' && sql.includes('FROM relay_assignments WHERE user_id')) {
        activityReachedAssignment.resolve()
      }
    })
    const completionStore = new RelayAssignmentStore(completionDatabase, () => now)
    const activityStore = new RelayAssignmentStore(activityDatabase, () => now)

    const completion = completionStore.completeReadyEvacuations()
    await assignmentLocked.promise
    const activity = activityStore.acquireActivity(identity, {
      activityId: 'install:queued-source-work',
      kind: 'install',
      cellId: sourceCellId
    })
    const activityRejected = expect(activity).rejects.toThrow(
      'activity_cell_not_authoritative'
    )
    await activityReachedAssignment.promise
    continueCompletion.resolve()

    await expect(completion).resolves.toBe(1)
    await activityRejected
    await expect(
      seedStore.cellEvacuationStatus(sourceCellId, targetCellId, false)
    ).resolves.toMatchObject({ inProgress: 0 })
  }, 15_000)

})
