import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
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
  attempts = 0

  constructor(
    private readonly database: RelayDatabase,
    private readonly hook: QueryLockHook,
    private readonly probeQueries = false
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
      this.attempts++
      return await operation(
        new QueryLockProbeTransaction(transaction, this.hook, this.probeQueries)
      )
    })
  }

  async close(): Promise<void> {}
}

class QueryLockProbeTransaction implements RelayDatabase {
  constructor(
    private readonly transactionDatabase: RelayDatabase,
    private readonly hook: QueryLockHook,
    private readonly probeQueries: boolean
  ) {}

  async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    if (this.probeQueries) await this.hook('before', sql)
    const rows = await this.transactionDatabase.query(sql, params)
    if (this.probeQueries) await this.hook('after', sql)
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

    expect([...attempts].sort()).toEqual([1, 2])
    const rows = await database.query(
      `SELECT scope_key, count FROM relay_rate_windows
       WHERE window_kind = ? ORDER BY scope_key`,
      ['transaction-recovery']
    )
    expect(rows).toEqual([
      { scope_key: keys[0], count: '1' },
      { scope_key: keys[1], count: '1' }
    ])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"event":"orca_relay_postgres_transaction_retry"')
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"phase":"rate-limit"'))
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('"event":"orca_relay_postgres_transaction_exhausted"')
    )
    warn.mockRestore()
  }, 10_000)

  it('defers assignment around a released-cell activity transaction', async () => {
    const now = 1_100_000_000_000
    const identity = { userId: 'released-order-user', relayHostId: 'releasedorder001' }
    const cellId = 'released-order-cell'
    const activityId = 'splice:released-order'
    await database.query(
      `DELETE FROM relay_assignment_activity_leases WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    await database.query(`DELETE FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`, [
      identity.userId,
      identity.relayHostId
    ])
    const seedStore = new RelayAssignmentStore(database, () => now)
    await seedStore.reconcileCells([
      { id: cellId, url: 'https://released-order.example.com', capacityRequests: 100 }
    ])
    const assignment = await seedStore.assign(identity)
    await seedStore.acquireActivity(identity, { activityId, kind: 'splice', cellId })

    const assignmentLocked = signal()
    const legacyCellLocked = signal()
    let gateFirstAssignmentAttempt = true
    const directorDatabase = new TransactionProbeDatabase(database, async (phase, sql) => {
      if (
        gateFirstAssignmentAttempt &&
        phase === 'after' &&
        sql.includes('FROM relay_assignments')
      ) {
        gateFirstAssignmentAttempt = false
        assignmentLocked.resolve()
        await legacyCellLocked.promise
      }
    })
    const directorStore = new RelayAssignmentStore(directorDatabase, () => now)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const directorAssign = directorStore.assign(identity)
    await assignmentLocked.promise
    let legacyAttempts = 0
    const legacyRelease = database.transaction(async (transaction) => {
      legacyAttempts++
      const lease = (
        await transaction.queryLocked(
          `SELECT * FROM relay_assignment_activity_leases
           WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
          [identity.userId, identity.relayHostId, activityId]
        )
      )[0]
      if (!lease) return
      await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [cellId])
      legacyCellLocked.resolve()
      await transaction.query(
        `UPDATE relay_cells SET reserved_requests = reserved_requests - 2 WHERE cell_id = ?`,
        [cellId]
      )
      await transaction.query(
        `DELETE FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
        [identity.userId, identity.relayHostId, activityId]
      )
      await transaction.query(
        `UPDATE relay_assignments SET reserved_splices = reserved_splices - 1
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    })

    await Promise.all([directorAssign, legacyRelease])

    expect(directorDatabase.attempts).toBe(2)
    expect(legacyAttempts).toBe(1)
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('orca_relay_postgres_transaction_retry')
    )
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('orca_relay_postgres_transaction_exhausted')
    )
    await expect(seedStore.resolve(identity)).resolves.toMatchObject({
      cellId,
      assignmentEpoch: assignment.assignmentEpoch
    })
    const state = await database.query(
      `SELECT assignment.reserved_controls, assignment.reserved_splices,
         cell.reserved_requests
       FROM relay_assignments assignment
       JOIN relay_cells cell ON cell.cell_id = assignment.cell_id
       WHERE assignment.user_id = ? AND assignment.relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    expect(state).toEqual([
      { reserved_controls: '1', reserved_splices: '0', reserved_requests: '1' }
    ])
    warn.mockRestore()
  }, 15_000)

  it('renews an existing control without waiting on a legacy cell lock', async () => {
    const now = 1_150_000_000_000
    const identity = { userId: 'sustained-lock-user', relayHostId: 'sustainedlock01' }
    const cell = {
      id: 'sustained-lock-cell',
      url: 'https://sustained-lock.example.com',
      capacityRequests: 100
    }
    const seedStore = new RelayAssignmentStore(database, () => now)
    await seedStore.reconcileCells([cell])
    await seedStore.assign(identity)

    const legacyCellLocked = signal()
    const releaseLegacyCell = signal()
    const legacyTransaction = database.transaction(async (transaction) => {
      await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [cell.id])
      legacyCellLocked.resolve()
      await releaseLegacyCell.promise
    })
    await legacyCellLocked.promise

    let inventoryAttempts = 0
    const assignmentDatabase = new TransactionProbeDatabase(
      database,
      async (phase, sql) => {
        if (phase !== 'before' || !sql.includes('FROM relay_cells ORDER BY')) return
        inventoryAttempts++
      }
    )
    const assignmentStore = new RelayAssignmentStore(assignmentDatabase, () => now)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(assignmentStore.assign(identity)).resolves.toMatchObject({
      cellId: cell.id
    })
    releaseLegacyCell.resolve()
    await expect(legacyTransaction).resolves.toBeUndefined()
    expect(inventoryAttempts).toBe(0)
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('orca_relay_postgres_transaction_retry')
    )
    warn.mockRestore()
  }, 15_000)

  it('retries a new sticky control without forming a legacy cell-first deadlock', async () => {
    const now = 1_175_000_000_000
    const identity = {
      userId: 'sticky-cell-contention-user',
      relayHostId: 'stickycellwait1'
    }
    const cell = {
      id: 'sticky-cell-contention-cell',
      url: 'https://sticky-cell-contention.example.com',
      capacityRequests: 100
    }
    const seedStore = new RelayAssignmentStore(database, () => now)
    await seedStore.reconcileCells([cell])
    await seedStore.assign(identity)
    await seedStore.changeActivity(identity, 'migration', 1)
    // Drops the grant's pending lease too: a sticky control the rows do not
    // show is what sends the retry through the NOWAIT cell lock.
    await seedStore.releaseActivity(identity, 'control-pending:1')

    const legacyCellLocked = signal()
    const directorAssignmentLocked = signal()
    const legacyTransaction = database.transaction(async (transaction) => {
      await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [cell.id])
      legacyCellLocked.resolve()
      await directorAssignmentLocked.promise
      await transaction.queryLocked(
        `SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    })
    await legacyCellLocked.promise

    let signalFirstAttempt = true
    const directorLockOrder: string[] = []
    const assignmentDatabase = new TransactionProbeDatabase(database, async (phase, sql) => {
      if (phase === 'before') {
        if (sql.includes('FROM relay_assignments WHERE user_id = ?')) {
          directorLockOrder.push('assignment')
        } else if (sql.includes('FROM relay_assignment_activity_leases')) {
          directorLockOrder.push('activity')
        } else if (sql.includes('FROM relay_cells ORDER BY')) {
          directorLockOrder.push('cell-inventory')
        } else if (sql.includes('FROM relay_cells WHERE cell_id = ?')) {
          directorLockOrder.push('cell')
        }
      }
      if (
        signalFirstAttempt &&
        phase === 'after' &&
        sql.includes('FROM relay_assignments WHERE user_id = ?')
      ) {
        signalFirstAttempt = false
        directorAssignmentLocked.resolve()
      }
    })
    const store = new RelayAssignmentStore(assignmentDatabase, () => now)

    await expect(store.assign(identity)).resolves.toMatchObject({
      cellId: cell.id,
      assignmentEpoch: 1
    })
    await expect(legacyTransaction).resolves.toBeUndefined()
    expect(assignmentDatabase.attempts).toBe(2)
    expect(directorLockOrder).toEqual([
      'assignment',
      'activity',
      'cell',
      'cell-inventory',
      'assignment',
      'activity'
    ])
    const state = await database.query(
      `SELECT assignment.reserved_controls, assignment.migration_leases,
         cell.reserved_requests
       FROM relay_assignments assignment
       JOIN relay_cells cell ON cell.cell_id = assignment.cell_id
       WHERE assignment.user_id = ? AND assignment.relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    expect(state).toEqual([
      { reserved_controls: '1', migration_leases: '1', reserved_requests: '2' }
    ])
  }, 15_000)

  it('serializes normalized assignment and activity release without a retry', async () => {
    const now = 1_200_000_000_000
    const identity = { userId: 'normalized-order-user', relayHostId: 'normalizedorder1' }
    const cellId = 'normalized-order-cell'
    const activityId = 'splice:normalized-order'
    await database.query(
      `DELETE FROM relay_assignment_activity_leases WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    await database.query(`DELETE FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`, [
      identity.userId,
      identity.relayHostId
    ])
    const seedStore = new RelayAssignmentStore(database, () => now)
    await seedStore.reconcileCells([
      { id: cellId, url: 'https://normalized-order.example.com', capacityRequests: 100 }
    ])
    await seedStore.assign(identity)
    await seedStore.acquireActivity(identity, { activityId, kind: 'splice', cellId })

    const assignmentLocked = signal()
    const releaseReachedAssignment = signal()
    const continueAssignment = signal()
    let gateFirstAssignmentAttempt = true
    const assignDatabase = new TransactionProbeDatabase(database, async (phase, sql) => {
      if (
        gateFirstAssignmentAttempt &&
        phase === 'after' &&
        sql.includes('FROM relay_assignments')
      ) {
        gateFirstAssignmentAttempt = false
        assignmentLocked.resolve()
        await continueAssignment.promise
      }
    })
    const releaseDatabase = new TransactionProbeDatabase(database, async (phase, sql) => {
      if (phase === 'before' && sql.includes('FROM relay_assignments')) {
        releaseReachedAssignment.resolve()
      }
    })
    const assignStore = new RelayAssignmentStore(assignDatabase, () => now)
    const releaseStore = new RelayAssignmentStore(releaseDatabase, () => now)

    const assign = assignStore.assign(identity)
    await assignmentLocked.promise
    const release = releaseStore.releaseActivity(identity, activityId)
    await releaseReachedAssignment.promise
    continueAssignment.resolve()
    await Promise.all([assign, release])

    expect(assignDatabase.attempts).toBe(1)
    expect(releaseDatabase.attempts).toBe(1)
    const state = await database.query(
      `SELECT assignment.reserved_controls, assignment.reserved_splices,
         cell.reserved_requests
       FROM relay_assignments assignment
       JOIN relay_cells cell ON cell.cell_id = assignment.cell_id
       WHERE assignment.user_id = ? AND assignment.relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    expect(state).toEqual([
      { reserved_controls: '1', reserved_splices: '0', reserved_requests: '1' }
    ])
  }, 15_000)

  it('takes the shared cell lock only for the final atomic activity write', async () => {
    const now = 1_250_000_000_000
    const cell = {
      id: 'atomic-final-cell',
      url: 'https://atomic-final.example.com',
      capacityRequests: 4
    }
    const identities = [
      { userId: 'atomic-final-user-a', relayHostId: 'atomicfinalhosta' },
      { userId: 'atomic-final-user-b', relayHostId: 'atomicfinalhostb' }
    ]
    const seedStore = new RelayAssignmentStore(database, () => now)
    await seedStore.reconcileCells([cell])
    await Promise.all(identities.map(async (identity) => await seedStore.assign(identity)))

    const firstAtCellWrite = signal()
    const secondAtCellWrite = signal()
    const releaseFirst = signal()
    const releaseSecond = signal()
    const isAtomicCellWrite = (sql: string): boolean =>
      sql.includes('UPDATE relay_cells SET reserved_requests') &&
      sql.includes('RETURNING cell_id')
    const firstDatabase = new TransactionProbeDatabase(
      database,
      async (phase, sql) => {
        if (phase !== 'before' || !isAtomicCellWrite(sql)) return
        firstAtCellWrite.resolve()
        await releaseFirst.promise
      },
      true
    )
    const secondDatabase = new TransactionProbeDatabase(
      database,
      async (phase, sql) => {
        if (phase !== 'before' || !isAtomicCellWrite(sql)) return
        secondAtCellWrite.resolve()
        await releaseSecond.promise
      },
      true
    )
    const first = new RelayAssignmentStore(firstDatabase, () => now).acquireActivity(
      identities[0]!,
      { activityId: 'splice:atomic-final-a', kind: 'splice', cellId: cell.id }
    )
    await firstAtCellWrite.promise
    const second = new RelayAssignmentStore(secondDatabase, () => now).acquireActivity(
      identities[1]!,
      { activityId: 'splice:atomic-final-b', kind: 'splice', cellId: cell.id }
    )
    let reachTimeout: ReturnType<typeof setTimeout> | undefined
    const secondReachedCellWrite = await Promise.race([
      secondAtCellWrite.promise.then(() => true),
      new Promise<false>((resolve) => {
        reachTimeout = setTimeout(() => resolve(false), 2_000)
      })
    ])
    if (reachTimeout) clearTimeout(reachTimeout)
    if (!secondReachedCellWrite) {
      releaseFirst.resolve()
      releaseSecond.resolve()
      await Promise.allSettled([first, second])
    }
    expect(secondReachedCellWrite).toBe(true)

    releaseFirst.resolve()
    await expect(first).resolves.toBeUndefined()
    releaseSecond.resolve()
    await expect(second).rejects.toThrow('relay_capacity_exhausted')
    await expect(
      database.query(
        `SELECT cell.reserved_requests, COUNT(lease.activity_id) AS leases,
                COALESCE(SUM(lease.request_units), 0) AS lease_units
         FROM relay_cells cell
         LEFT JOIN relay_assignment_activity_leases lease ON lease.cell_id = cell.cell_id
         WHERE cell.cell_id = ? GROUP BY cell.cell_id, cell.reserved_requests`,
        [cell.id]
      )
    ).resolves.toEqual([{ reserved_requests: '4', leases: '3', lease_units: '4' }])
    await expect(
      database.query(
        `SELECT user_id, reserved_splices FROM relay_assignments
         WHERE user_id IN (?, ?) ORDER BY user_id`,
        [identities[0]!.userId, identities[1]!.userId]
      )
    ).resolves.toEqual([
      { user_id: identities[0]!.userId, reserved_splices: '1' },
      { user_id: identities[1]!.userId, reserved_splices: '0' }
    ])
  }, 15_000)

  it('reconciles drift under the assignment-first lock order while activity waits', async () => {
    const now = 1_300_000_000_000
    const cells = [
      { id: 'reconcile-cell-a', url: 'https://reconcile-a.example.com', capacityRequests: 100 },
      { id: 'reconcile-cell-b', url: 'https://reconcile-b.example.com', capacityRequests: 100 }
    ]
    const identities = Array.from({ length: 12 }, (_, index) => ({
      userId: `reconcile-user-${index}`,
      relayHostId: `reconcilehost${String(index).padStart(4, '0')}`
    }))
    const seedStore = new RelayAssignmentStore(database, () => now)
    await seedStore.reconcileCells(cells)
    for (const identity of identities) await seedStore.assign(identity)
    await database.query(
      `UPDATE relay_assignments SET reserved_controls = 7, reserved_splices = 5
       WHERE user_id LIKE 'reconcile-user-%'`
    )
    await database.query(
      `UPDATE relay_cells SET reserved_requests = 42
       WHERE cell_id IN (?, ?)`,
      ['reconcile-cell-a', 'reconcile-cell-b']
    )

    const assignmentsLocked = signal()
    const activityReachedAssignment = signal()
    const continueReconciliation = signal()
    let gateReconciliation = true
    const reconcileDatabase = new TransactionProbeDatabase(database, async (phase, sql) => {
      if (
        gateReconciliation &&
        phase === 'after' &&
        sql.includes('SELECT assignment.* FROM relay_assignments assignment')
      ) {
        gateReconciliation = false
        assignmentsLocked.resolve()
        await continueReconciliation.promise
      }
    })
    const activityDatabase = new TransactionProbeDatabase(database, async (phase, sql) => {
      if (phase === 'before' && sql.includes('FROM relay_assignments WHERE user_id')) {
        activityReachedAssignment.resolve()
      }
    })
    const reconcileStore = new RelayAssignmentStore(reconcileDatabase, () => now)
    const activityStore = new RelayAssignmentStore(activityDatabase, () => now)

    const reconciliation = reconcileStore.cellEvacuationStatus(
      'reconcile-cell-a',
      'reconcile-cell-b',
      true
    )
    await assignmentsLocked.promise
    const activity = activityStore.acquireActivity(identities[0]!, {
      activityId: 'splice:reconcile',
      kind: 'splice',
      cellId: 'reconcile-cell-a'
    })
    await activityReachedAssignment.promise
    continueReconciliation.resolve()
    await Promise.all([reconciliation, activity])

    expect(reconcileDatabase.attempts).toBe(1)
    expect(activityDatabase.attempts).toBe(1)
    const reservations = await database.query(
      `SELECT cell.cell_id, cell.reserved_requests,
         COALESCE(SUM(lease.request_units), 0) AS lease_units
       FROM relay_cells cell
       LEFT JOIN relay_assignment_activity_leases lease ON lease.cell_id = cell.cell_id
       WHERE cell.cell_id IN (?, ?)
       GROUP BY cell.cell_id, cell.reserved_requests ORDER BY cell.cell_id`,
      ['reconcile-cell-a', 'reconcile-cell-b']
    )
    expect(reservations).toEqual([
      { cell_id: 'reconcile-cell-a', reserved_requests: '8', lease_units: '8' },
      { cell_id: 'reconcile-cell-b', reserved_requests: '6', lease_units: '6' }
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

  it('defers completion instead of deadlocking with a legacy cell-first lock', async () => {
    const now = 1_500_000_000_000
    const identity = {
      userId: 'completion-contention-user',
      relayHostId: 'completionwait01'
    }
    const sourceCell = {
      id: 'completion-contention-source',
      url: 'https://completion-contention-source.example.com',
      capacityRequests: 100
    }
    const targetCell = {
      id: 'completion-contention-target',
      url: 'https://completion-contention-target.example.com',
      capacityRequests: 100
    }
    const store = new RelayAssignmentStore(database, () => now, {
      requireLiveCells: true
    })
    await store.reconcileCells([sourceCell, targetCell])
    await store.recordCellHeartbeat({
      cellId: sourceCell.id,
      cellUrl: sourceCell.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: now - 100,
      ready: true,
      observedRequests: 0
    })
    await store.recordCellHeartbeat({
      cellId: targetCell.id,
      cellUrl: targetCell.url,
      cellIncarnation: '22222222-2222-4222-8222-222222222222',
      startedAt: now - 100,
      ready: true,
      observedRequests: 0
    })
    const assignment = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: sourceCell.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    const migration = await store.startEvacuation(identity, targetCell.id)
    await store.activateControl(identity, {
      cellId: targetCell.id,
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: targetCell.id,
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.releaseActivity(identity, sourceControl)
    await store.setCellEnabled(sourceCell.id, false)

    const legacyCellLocked = signal()
    const completionAssignmentLocked = signal()
    const legacyTransaction = database.transaction(async (transaction) => {
      await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [
        sourceCell.id
      ])
      legacyCellLocked.resolve()
      await completionAssignmentLocked.promise
      await transaction.queryLocked(
        `SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    })
    await legacyCellLocked.promise

    let signalCompletion = true
    const completionDatabase = new TransactionProbeDatabase(
      database,
      async (phase, sql) => {
        if (
          signalCompletion &&
          phase === 'after' &&
          sql.includes('FROM relay_assignments WHERE user_id')
        ) {
          signalCompletion = false
          completionAssignmentLocked.resolve()
        }
      }
    )
    const completionStore = new RelayAssignmentStore(completionDatabase, () => now, {
      requireLiveCells: true
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(completionStore.completeReadyEvacuations()).resolves.toBe(0)
    await expect(legacyTransaction).resolves.toBeUndefined()
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('orca_relay_postgres_transaction_retry')
    )
    await expect(store.completeReadyEvacuations()).resolves.toBe(1)
  }, 15_000)

  it('normalizes persistent dead-source inventory contention', async () => {
    let now = 1_550_000_000_000
    const identity = {
      userId: 'dead-source-contention-user',
      relayHostId: 'deadsourcewait01'
    }
    const secondIdentity = {
      userId: identity.userId,
      relayHostId: 'deadsourcewait02'
    }
    const sourceCell = {
      id: 'dead-source-contention-source',
      url: 'https://dead-source-contention-source.example.com',
      capacityRequests: 100
    }
    const targetCell = {
      id: 'dead-source-contention-target',
      url: 'https://dead-source-contention-target.example.com',
      capacityRequests: 100
    }
    const sourceIncarnation = '11111111-1111-4111-8111-111111111111'
    const targetIncarnation = '22222222-2222-4222-8222-222222222222'
    const store = new RelayAssignmentStore(database, () => now, {
      requireLiveCells: true
    })
    await store.reconcileCells([sourceCell, targetCell])
    await store.setCellEnabled(targetCell.id, false)
    await store.recordCellHeartbeat({
      cellId: sourceCell.id,
      cellUrl: sourceCell.url,
      cellIncarnation: sourceIncarnation,
      startedAt: now - 100,
      ready: true,
      observedRequests: 0
    })
    await store.recordCellHeartbeat({
      cellId: targetCell.id,
      cellUrl: targetCell.url,
      cellIncarnation: targetIncarnation,
      startedAt: now - 100,
      ready: true,
      observedRequests: 0
    })
    const assignment = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: sourceCell.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    await store.setCellEnabled(targetCell.id, true)
    const migration = await store.startEvacuation(identity, targetCell.id)
    await store.activateControl(identity, {
      cellId: targetCell.id,
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: targetCell.id,
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.releaseActivity(identity, sourceControl)
    const secondAssignment = await store.assign(secondIdentity)
    expect(secondAssignment.cellId).toBe(sourceCell.id)
    const secondSourceControl = await store.activateControl(secondIdentity, {
      cellId: sourceCell.id,
      assignmentEpoch: secondAssignment.assignmentEpoch,
      generation: 1
    })
    const secondMigration = await store.startEvacuation(secondIdentity, targetCell.id)
    await store.activateControl(secondIdentity, {
      cellId: targetCell.id,
      assignmentEpoch: secondMigration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(secondIdentity, {
      cellId: targetCell.id,
      assignmentEpoch: secondMigration.assignmentEpoch
    })
    await store.releaseActivity(secondIdentity, secondSourceControl)
    await store.setCellEnabled(sourceCell.id, false)
    now += 45_001
    await store.recordCellHeartbeat({
      cellId: targetCell.id,
      cellUrl: targetCell.url,
      cellIncarnation: targetIncarnation,
      startedAt: now - 45_101,
      ready: true,
      observedRequests: 0
    })
    await store.attestCellFence(sourceCell.id, sourceIncarnation)

    const legacyCellLocked = signal()
    const completionAssignmentLocked = signal()
    const legacyTransaction = database.transaction(async (transaction) => {
      await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [
        sourceCell.id
      ])
      legacyCellLocked.resolve()
      await completionAssignmentLocked.promise
      await transaction.queryLocked(
        `SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    })
    await legacyCellLocked.promise

    let signalCompletion = true
    const fallbackInventoryLocked = signal()
    const freshAssignmentLocked = signal()
    const persistentInventoryLocked = signal()
    let releasePersistentInventory = false
    const completionDatabase = new TransactionProbeDatabase(
      database,
      async (phase, sql) => {
        if (
          signalCompletion &&
          phase === 'after' &&
          sql.includes('FROM relay_assignments WHERE user_id')
        ) {
          signalCompletion = false
          completionAssignmentLocked.resolve()
        } else if (
          phase === 'after' &&
          sql.trim() === 'SELECT * FROM relay_cells ORDER BY cell_id ASC'
        ) {
          fallbackInventoryLocked.resolve()
          await freshAssignmentLocked.promise
        }
      }
    )
    const completionStore = new RelayAssignmentStore(completionDatabase, () => now, {
      requireLiveCells: true
    })
    const freshAssignmentTransaction = database.transaction(async (transaction) => {
      await fallbackInventoryLocked.promise
      await transaction.queryLocked(
        `SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
      freshAssignmentLocked.resolve()
      await transaction.queryLocked(`SELECT * FROM relay_cells ORDER BY cell_id ASC`)
      persistentInventoryLocked.resolve()
      while (!releasePersistentInventory) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        await transaction.query(`SELECT 1`)
      }
    })

    const completion = completionStore.cellEvacuationStatus(
      sourceCell.id,
      targetCell.id,
      true
    )
    await persistentInventoryLocked.promise
    await expect(
      completion
    ).resolves.toMatchObject({ inProgress: 2, completed: 0, blocked: 2 })
    await expect(legacyTransaction).resolves.toBeUndefined()
    releasePersistentInventory = true
    await expect(freshAssignmentTransaction).resolves.toBeUndefined()
    await expect(
      store.cellEvacuationStatus(sourceCell.id, targetCell.id, true)
    ).resolves.toMatchObject({ inProgress: 0, completed: 2, blocked: 0 })
  }, 25_000)

  it('defers expired lease cleanup around a legacy cell-first lock', async () => {
    const now = 1_600_000_000_000
    const identity = {
      userId: 'lease-contention-user',
      relayHostId: 'leasecontention1'
    }
    const cell = {
      id: 'lease-contention-cell',
      url: 'https://lease-contention-cell.example.com',
      capacityRequests: 100
    }
    const store = new RelayAssignmentStore(database, () => now)
    await store.reconcileCells([cell])
    await store.assign(identity)
    await database.query(
      `UPDATE relay_assignment_activity_leases SET expires_at = ?
       WHERE user_id = ? AND relay_host_id = ?`,
      [now - 1, identity.userId, identity.relayHostId]
    )

    const legacyCellLocked = signal()
    const cleanupAssignmentLocked = signal()
    const legacyTransaction = database.transaction(async (transaction) => {
      await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [cell.id])
      legacyCellLocked.resolve()
      await cleanupAssignmentLocked.promise
      await transaction.queryLocked(
        `SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    })
    await legacyCellLocked.promise

    let signalCleanup = true
    const cleanupDatabase = new TransactionProbeDatabase(database, async (phase, sql) => {
      if (
        signalCleanup &&
        phase === 'after' &&
        sql.includes('FROM relay_assignments WHERE user_id')
      ) {
        signalCleanup = false
        cleanupAssignmentLocked.resolve()
      }
    })
    const cleanupStore = new RelayAssignmentStore(cleanupDatabase, () => now)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(cleanupStore.releaseExpiredActivityLeases()).resolves.toBe(0)
    await expect(legacyTransaction).resolves.toBeUndefined()
    expect(cleanupDatabase.attempts).toBe(1)
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('orca_relay_postgres_transaction_retry')
    )
    await expect(store.releaseExpiredActivityLeases()).resolves.toBe(1)
  }, 15_000)

  it('skips an expired lease when another director owns its assignment lock', async () => {
    const now = 1_650_000_000_000
    const identity = {
      userId: 'lease-assignment-contention-user',
      relayHostId: 'leaseassignment1'
    }
    const cell = {
      id: 'lease-assignment-contention-cell',
      url: 'https://lease-assignment-contention-cell.example.com',
      capacityRequests: 100
    }
    const store = new RelayAssignmentStore(database, () => now)
    await store.reconcileCells([cell])
    await store.assign(identity)
    await database.query(
      `UPDATE relay_assignment_activity_leases SET expires_at = ?
       WHERE user_id = ? AND relay_host_id = ?`,
      [now - 1, identity.userId, identity.relayHostId]
    )

    const assignmentLocked = signal()
    const releaseAssignment = signal()
    const legacyTransaction = database.transaction(async (transaction) => {
      await transaction.queryLocked(
        `SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
      assignmentLocked.resolve()
      await releaseAssignment.promise
    })
    await assignmentLocked.promise

    const cleanupDatabase = new TransactionProbeDatabase(database, async () => undefined)
    const cleanupStore = new RelayAssignmentStore(cleanupDatabase, () => now)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(cleanupStore.releaseExpiredActivityLeases()).resolves.toBe(0)
    expect(cleanupDatabase.attempts).toBe(1)
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('orca_relay_postgres_transaction_retry')
    )
    warn.mockRestore()

    releaseAssignment.resolve()
    await expect(legacyTransaction).resolves.toBeUndefined()
    await expect(store.releaseExpiredActivityLeases()).resolves.toBe(1)
  }, 15_000)

  it('defers aggregate expiry cleanup around a legacy cell-first lock', async () => {
    const now = 1_700_000_000_000
    const identity = {
      userId: 'aggregate-contention-user',
      relayHostId: 'aggregatewait01'
    }
    const cell = {
      id: 'aggregate-contention-cell',
      url: 'https://aggregate-contention-cell.example.com',
      capacityRequests: 100
    }
    const store = new RelayAssignmentStore(database, () => now)
    await store.reconcileCells([cell])
    await store.assign(identity)
    await database.query(
      `DELETE FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    await database.query(
      `UPDATE relay_assignments SET lease_expires_at = ?
       WHERE user_id = ? AND relay_host_id = ?`,
      [now - 1, identity.userId, identity.relayHostId]
    )

    const legacyCellLocked = signal()
    const cleanupAssignmentsLocked = signal()
    const legacyTransaction = database.transaction(async (transaction) => {
      await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [cell.id])
      legacyCellLocked.resolve()
      await cleanupAssignmentsLocked.promise
      await transaction.queryLocked(
        `SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    })
    await legacyCellLocked.promise

    let signalCleanup = true
    const cleanupDatabase = new TransactionProbeDatabase(database, async (phase, sql) => {
      if (
        signalCleanup &&
        phase === 'after' &&
        sql.includes('FROM relay_assignments WHERE lease_expires_at')
      ) {
        signalCleanup = false
        cleanupAssignmentsLocked.resolve()
      }
    })
    const cleanupStore = new RelayAssignmentStore(cleanupDatabase, () => now)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(cleanupStore.releaseExpiredActivity()).resolves.toBe(0)
    await expect(legacyTransaction).resolves.toBeUndefined()
    expect(cleanupDatabase.attempts).toBe(1)
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('orca_relay_postgres_transaction_retry')
    )
    await expect(store.releaseExpiredActivity()).resolves.toBe(1)
  }, 15_000)

  it('defers aggregate expiry before waiting on a legacy assignment row', async () => {
    const now = 1_700_000_000_000
    const identity = {
      userId: 'aggregate-contention-user',
      relayHostId: 'aggregatewait01'
    }
    const cell = {
      id: 'aggregate-contention-cell',
      url: 'https://aggregate-contention-cell.example.com',
      capacityRequests: 100
    }
    const store = new RelayAssignmentStore(database, () => now)
    await store.reconcileCells([cell])
    await store.assign(identity)
    await database.query(
      `DELETE FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    await database.query(
      `UPDATE relay_assignments SET lease_expires_at = ?
       WHERE user_id = ? AND relay_host_id = ?`,
      [now - 1, identity.userId, identity.relayHostId]
    )

    const legacyAssignmentLocked = signal()
    const releaseLegacyAssignment = signal()
    const legacyTransaction = database.transaction(async (transaction) => {
      await transaction.queryLocked(
        `SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
      legacyAssignmentLocked.resolve()
      await releaseLegacyAssignment.promise
    })
    await legacyAssignmentLocked.promise

    const timedOut = Symbol('timed-out')
    const cleanup = store.releaseExpiredActivity()
    const result = await Promise.race([
      cleanup,
      new Promise<typeof timedOut>((resolve) => {
        setTimeout(() => resolve(timedOut), 750)
      })
    ])
    releaseLegacyAssignment.resolve()
    await legacyTransaction
    if (result === timedOut) await cleanup

    expect(result).toBe(0)
    await expect(store.releaseExpiredActivity()).resolves.toBe(1)
  }, 15_000)

  it('keeps concurrent dormant reassignments capacity-consistent', async () => {
    const now = 1_000_000_000_000
    const serializedDatabase = new TransactionProbeDatabase(database, async () => undefined)
    const store = new RelayAssignmentStore(serializedDatabase, () => now)
    await database.query(
      `DELETE FROM relay_assignment_activity_leases WHERE user_id LIKE 'postgres-user-%'`
    )
    await database.query(`DELETE FROM relay_assignments WHERE user_id LIKE 'postgres-user-%'`)
    await database.query(`DELETE FROM relay_cells WHERE cell_id IN (?, ?, ?)`, [
      'cell-a',
      'cell-b',
      'cell-c'
    ])
    await store.reconcileCells([
      { id: 'cell-a', url: 'https://cell-a.example.com', capacityRequests: 100 },
      { id: 'cell-b', url: 'https://cell-b.example.com', capacityRequests: 100 },
      { id: 'cell-c', url: 'https://cell-c.example.com', capacityRequests: 100 }
    ])
    const identities = Array.from({ length: 30 }, (_, index) => ({
      userId: `postgres-user-${index}`,
      relayHostId: `postgreshost${String(index).padStart(5, '0')}`
    }))
    await Promise.all(identities.map(async (identity) => await store.assign(identity)))

    await database.query(`DELETE FROM relay_assignment_activity_leases`)
    await database.query(
      `UPDATE relay_assignments SET lease_expires_at = ?, last_activity_at = ?,
       reserved_controls = 0, reserved_splices = 0, reserved_invites = 0,
       pending_installs = 0, pending_confirmations = 0, migration_leases = 0`,
      [0, 0]
    )
    await database.query(`UPDATE relay_cells SET reserved_requests = 0`)

    await Promise.all(identities.map(async (identity) => await store.assign(identity)))

    const reservations = await database.query(
      `SELECT cell_id, reserved_requests FROM relay_cells ORDER BY cell_id`
    )
    expect(reservations).toEqual([
      { cell_id: 'cell-a', reserved_requests: '10' },
      { cell_id: 'cell-b', reserved_requests: '10' },
      { cell_id: 'cell-c', reserved_requests: '10' }
    ])
    expect(serializedDatabase.attempts).toBe(121)
  }, 10_000)

  it('renews independent sticky assignments concurrently without the placement queue', async () => {
    const now = 1_800_000_000_000
    const identities = Array.from({ length: 6 }, (_, index) => ({
      userId: `sticky-fast-user-${index}`,
      relayHostId: `stickyfast${String(index).padStart(6, '0')}`
    }))
    const cell = {
      id: 'sticky-fast-cell',
      url: 'https://sticky-fast.example.com',
      capacityRequests: 100
    }
    const seedStore = new RelayAssignmentStore(database, () => now)
    await seedStore.reconcileCells([cell])
    for (const identity of identities) await seedStore.assign(identity)

    const allRenewalsReachedDatabase = signal()
    const releaseRenewals = signal()
    let renewalArrivals = 0
    const probedDatabase = new TransactionProbeDatabase(database, async (phase, sql) => {
      if (
        phase !== 'after' ||
        !sql.includes('FROM relay_assignments WHERE user_id = ?')
      ) {
        return
      }
      renewalArrivals++
      if (renewalArrivals === identities.length) allRenewalsReachedDatabase.resolve()
      await releaseRenewals.promise
    })
    const store = new RelayAssignmentStore(probedDatabase, () => now)
    const renewals = identities.map(async (identity) => await store.assign(identity))
    let reachedBeforeTimeout = false
    try {
      reachedBeforeTimeout = await Promise.race([
        allRenewalsReachedDatabase.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000))
      ])
    } finally {
      releaseRenewals.resolve()
      await Promise.all(renewals)
    }

    expect(reachedBeforeTimeout).toBe(true)
    expect(renewalArrivals).toBe(identities.length)
    expect(probedDatabase.attempts).toBe(identities.length)
    const state = await database.query(
      `SELECT COUNT(*) AS assignments, SUM(reserved_controls) AS controls
       FROM relay_assignments WHERE user_id LIKE 'sticky-fast-user-%'`
    )
    expect(state).toEqual([{ assignments: '6', controls: '6' }])
  }, 10_000)
})
