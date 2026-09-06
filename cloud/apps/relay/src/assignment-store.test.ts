import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayCellConfig } from './config.js'
import { RelayAssignmentStore, STRANDED_MIGRATION_ABANDON_MS } from './assignment-store.js'
import {
  encodeMembership,
  type CellAdmissionMembership
} from './cell-admission-selector.js'
import {
  openInMemoryRelayDatabase,
  type RelayDatabase,
  type RelayLockOptions,
  type RelayTransactionOptions,
  type SqlRow
} from './database.js'

const CELLS: RelayCellConfig[] = [
  { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 2 },
  { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 2 }
]
const NO_EXPIRED_EVACUATION_DIAGNOSTICS = {
  expiredUnregistered: 0,
  repairableExpiredUnregistered: 0,
  abortableExpiredUnregistered: 0,
  blockedExpiredUnregistered: 0,
  blockedExpiredOnNewerTargetAssignment: 0
}
const NO_REGISTERED_EVACUATION_DIAGNOSTICS = {
  registeredSourceActive: 0,
  registeredCompletable: 0,
  registeredTargetInactive: 0
}
const NO_ACTIVE_MIGRATION_LEASE = {
  oldestExpiresAt: null,
  oldestRemainingMs: null
}
const FENCE_PLAN_BINDING = {
  planObjectName:
    'terraform/state/relay-fence-plans/production/22222222-2222-4222-8222-222222222222.tfplan',
  planObjectGeneration: '123456789',
  varFileSha256: 'c'.repeat(64),
  terraformStateLineage: '33333333-3333-4333-8333-333333333333',
  terraformStateSerial: 7,
  terraformStateObjectGeneration: '987654321',
  terraformStateObjectSha256: 'd'.repeat(64),
  requestReason:
    'orca-relay-fence/22222222-2222-4222-8222-222222222222'
}
const FENCE_INVOCATION_ID = '55555555-5555-4555-8555-555555555555'
const FENCE_INVOCATION_REASON =
  `${FENCE_PLAN_BINDING.requestReason}/${FENCE_INVOCATION_ID}`

async function applyGenerationZeroSelector(
  store: RelayAssignmentStore,
  input: {
    attemptId: string
    membership: CellAdmissionMembership
  }
) {
  const current = (await store.inspectCellAdmissionSelector()).selector.membership
  return await store.applyCellAdmissionSelector({
    ...input,
    expectedGeneration: 0,
    expectedMembershipSha256: createHash('sha256')
      .update(encodeMembership(current))
      .digest('hex')
  })
}

function cellFenceEvidence(attemptId = '22222222-2222-4222-8222-222222222222') {
  return {
    attemptId,
    environment: 'production' as const,
    cellId: 'cell-a',
    cellIncarnation: '11111111-1111-4111-8111-111111111111',
    migName: 'orca-relay-c1',
    instanceGroup: 'https://compute.example/instanceGroups/orca-relay-c1',
    generationIdentity: 'https://compute.example/instanceTemplates/orca-relay-c1-abc',
    fenceCommit: 'a'.repeat(40),
    planSha256: 'b'.repeat(64),
    ...FENCE_PLAN_BINDING
  }
}

class OneShotInventoryFailureDatabase implements RelayDatabase {
  readonly retryLocks: string[] = []
  private armed = false
  private failed = false

  constructor(private readonly delegate: RelayDatabase) {}

  arm(): void {
    this.armed = true
  }

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    return await this.delegate.query(sql, params)
  }

  async queryLocked(
    sql: string,
    params: unknown[] = [],
    options: RelayLockOptions = {}
  ): Promise<SqlRow[]> {
    return await this.lockedQuery(this.delegate, sql, params, options)
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    return await this.delegate.transaction(
      async (transaction) =>
        await operation({
          query: async (sql, params = []) => await transaction.query(sql, params),
          queryLocked: async (sql, params = [], options = {}) =>
            await this.lockedQuery(transaction, sql, params, options),
          transaction: async (nested) => await transaction.transaction(nested),
          close: async () => {}
        })
    )
  }

  async close(): Promise<void> {
    await this.delegate.close()
  }

  private async lockedQuery(
    database: RelayDatabase,
    sql: string,
    params: unknown[],
    options: RelayLockOptions
  ): Promise<SqlRow[]> {
    const inventory = sql.trim() === 'SELECT * FROM relay_cells ORDER BY cell_id ASC'
    if (this.armed && inventory && options.failIfUnavailable) {
      this.armed = false
      this.failed = true
      this.retryLocks.push('inventory-nowait-failed')
      throw new Error('database_lock_unavailable')
    }
    if (this.failed && inventory) this.retryLocks.push('inventory-first')
    if (this.failed && sql.includes('FROM relay_assignments')) {
      this.retryLocks.push(options.failIfUnavailable ? 'assignment-nowait' : 'assignment')
    }
    return await database.queryLocked(sql, params, options)
  }
}

class RepeatedDrainAccountingFailureDatabase implements RelayDatabase {
  refreshAttempts = 0
  private armed = false
  private failuresRemaining = 0

  constructor(private readonly delegate: RelayDatabase) {}

  arm(failures: number): void {
    this.armed = true
    this.failuresRemaining = failures
    this.refreshAttempts = 0
  }

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    return await this.delegate.query(sql, params)
  }

  async queryLocked(
    sql: string,
    params: unknown[] = [],
    options: RelayLockOptions = {}
  ): Promise<SqlRow[]> {
    return await this.lockedQuery(this.delegate, sql, params, options)
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    return await this.delegate.transaction(
      async (transaction) =>
        await operation({
          query: async (sql, params = []) => await transaction.query(sql, params),
          queryLocked: async (sql, params = [], options = {}) =>
            await this.lockedQuery(transaction, sql, params, options),
          transaction: async (nested) => await transaction.transaction(nested),
          close: async () => {}
        })
    )
  }

  async close(): Promise<void> {
    await this.delegate.close()
  }

  private async lockedQuery(
    database: RelayDatabase,
    sql: string,
    params: unknown[],
    options: RelayLockOptions
  ): Promise<SqlRow[]> {
    const drainRefresh =
      sql.includes('SELECT migration.*') &&
      sql.includes('WHERE migration.source_cell_id = ?') &&
      !sql.includes('source_cell_incarnation')
    if (this.armed && drainRefresh) {
      this.refreshAttempts++
      if (this.failuresRemaining > 0) {
        this.failuresRemaining--
        throw new Error('migration_activity_accounting_mismatch')
      }
    }
    return await database.queryLocked(sql, params, options)
  }
}

// Runs a side effect between the sticky lane and the placement lane, the window
// in which a host can acquire control after the sticky read called it dormant.
class SeedBetweenAssignmentLanesDatabase implements RelayDatabase {
  private transactions = 0
  private armed = false

  constructor(
    private readonly delegate: RelayDatabase,
    private readonly seed: () => Promise<void>
  ) {}

  arm(): void {
    this.armed = true
    this.transactions = 0
  }

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    return await this.delegate.query(sql, params)
  }

  async queryLocked(
    sql: string,
    params: unknown[] = [],
    options: RelayLockOptions = {}
  ): Promise<SqlRow[]> {
    return await this.delegate.queryLocked(sql, params, options)
  }

  async transaction<T>(
    operation: (transaction: RelayDatabase) => Promise<T>,
    options?: RelayTransactionOptions
  ): Promise<T> {
    if (this.armed && ++this.transactions === 2) await this.seed()
    return await this.delegate.transaction(operation, options)
  }

  async close(): Promise<void> {
    await this.delegate.close()
  }
}

describe('RelayAssignmentStore', () => {
  let database: RelayDatabase | undefined

  afterEach(async () => await database?.close())

  async function setup(now: () => number, cells = CELLS): Promise<RelayAssignmentStore> {
    database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, now)
    await store.reconcileCells(cells)
    return store
  }

  async function setupWithHeartbeats(
    now: () => number,
    cells = CELLS
  ): Promise<RelayAssignmentStore> {
    database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    await store.reconcileCells(cells)
    return store
  }

  async function heartbeat(
    store: RelayAssignmentStore,
    cell = CELLS[0]!,
    input: {
      incarnation?: string
      startedAt?: number
      ready?: boolean
      observedRequests?: number
    } = {}
  ): Promise<void> {
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: input.incarnation ?? '11111111-1111-4111-8111-111111111111',
      startedAt: input.startedAt ?? 50,
      ready: input.ready ?? true,
      observedRequests: input.observedRequests ?? 0,
      ...(cell.connectionHardCap === undefined
        ? {}
        : {
            totalConnections: 0,
            inFlightConnections: 0,
            reservedConnectionUnits: 0,
            enforcedConnectionUnits: 0,
            connectionHardCap: cell.connectionHardCap,
            connectionUnobservedBound: cell.connectionUnobservedBound
          })
    })
  }

  it('admits only cells with a fresh ready heartbeat', async () => {
    let now = 100
    const store = await setupWithHeartbeats(() => now, [CELLS[0]!])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }

    await expect(store.assign(identity)).rejects.toThrow('relay_capacity_exhausted')
    await heartbeat(store, CELLS[0]!, { ready: false })
    await expect(store.assign(identity)).rejects.toThrow('relay_capacity_exhausted')
    await heartbeat(store)
    expect((await store.assign(identity)).cellId).toBe('cell-a')
    now += 45_001
    expect(await store.resolve(identity)).toBeNull()
  })

  it('fences stale incarnations and origin mismatches', async () => {
    const store = await setupWithHeartbeats(() => 100, [CELLS[0]!])
    await heartbeat(store, CELLS[0]!, { startedAt: 50 })
    await expect(
      heartbeat(store, { ...CELLS[0]!, url: 'https://other.example.com' })
    ).rejects.toThrow('cell_origin_mismatch')
    await expect(
      heartbeat(store, CELLS[0]!, {
        incarnation: '22222222-2222-4222-8222-222222222222',
        startedAt: 50
      })
    ).rejects.toThrow('stale_cell_incarnation')
    await heartbeat(store, CELLS[0]!, {
      incarnation: '22222222-2222-4222-8222-222222222222',
      startedAt: 51
    })
    await expect(heartbeat(store, CELLS[0]!, { startedAt: 50 })).rejects.toThrow(
      'stale_cell_incarnation'
    )
  })

  it('records receipt-relative legacy drain states and pins post-send migrations', async () => {
    let now = 100
    const store = await setupWithHeartbeats(() => now)
    await heartbeat(store, CELLS[0]!)
    await heartbeat(store, CELLS[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222'
    })
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.assign(identity)
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await database!.query(
      `UPDATE relay_assignments SET migration_leases = migration_leases + 1
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    const incarnation = '11111111-1111-4111-8111-111111111111'
    const attemptId = '33333333-3333-4333-8333-333333333333'
    const traceValue = '44444444-4444-4444-8444-444444444444'

    await expect(
      store.prepareCellDrainAttempt({
        attemptId,
        cellId: 'cell-a',
        cellIncarnation: incarnation,
        traceValue,
        plannedGraceMs: 120_000
      })
    ).resolves.toMatchObject({ state: 'prepared', shouldSend: false })
    expect(
      await database!.query(`SELECT * FROM relay_post_drain_migration_pins`)
    ).toEqual([])
    await expect(
      store.prepareCellDrainRecovery({
        attemptId,
        cellId: 'cell-a',
        cellIncarnation: incarnation
      })
    ).resolves.toMatchObject({
      shouldSend: false,
      preparedAttempt: {
        attemptId,
        state: 'prepared',
        traceValue,
        plannedGraceMs: 120_000
      }
    })

    await expect(
      store.beginCellDrainSend({
        attemptId,
        cellId: 'cell-a',
        cellIncarnation: incarnation
      })
    ).resolves.toMatchObject({
      state: 'send-may-have-started',
      shouldSend: true,
      sendPermitExpiresAt: 30_100
    })
    await expect(
      database!.query(
        `SELECT migration_leases FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).resolves.toEqual([{ migration_leases: 1 }])
    await expect(
      store.beginCellDrainSend({
        attemptId,
        cellId: 'cell-a',
        cellIncarnation: incarnation
      })
    ).resolves.toMatchObject({
      state: 'send-may-have-started',
      shouldSend: false
    })
    await expect(
      store.prepareCellDrainRecovery({
        attemptId,
        cellId: 'cell-a',
        cellIncarnation: incarnation
      })
    ).rejects.toThrow('drain_application_receipt_missing')
    expect(
      await database!.query(
        `SELECT drain_attempt_id, source_cell_id, source_cell_incarnation,
           target_cell_id, assignment_epoch
         FROM relay_post_drain_migration_pins`
      )
    ).toEqual([
      {
        drain_attempt_id: attemptId,
        source_cell_id: 'cell-a',
        source_cell_incarnation: incarnation,
        target_cell_id: 'cell-b',
        assignment_epoch: migration.assignmentEpoch
      }
    ])

    now = migration.expiresAt + 1
    expect(await store.abortExpiredEvacuations()).toBe(0)
    expect(await store.releaseExpiredActivityLeases()).toBe(1)
    expect(
      await database!.query(
        `SELECT activity_kind, cell_id FROM relay_assignment_activity_leases
         WHERE user_id = ? ORDER BY activity_kind`,
        [identity.userId]
      )
    ).toEqual([
      { activity_kind: 'control', cell_id: 'cell-b' },
      { activity_kind: 'migration', cell_id: 'cell-b' }
    ])

    now = 200_000
    await expect(
      store.recordCellDrainApplicationReceipt({
        attemptId,
        cellId: 'cell-a',
        cellIncarnation: incarnation,
        traceValue,
        backendStatus: 200
      })
    ).resolves.toMatchObject({
      state: 'application-receipt',
      applicationReceiptAt: 200_000,
      retryAfter: 350_000
    })
    await expect(
      store.prepareCellDrainRecovery({ attemptId, cellId: 'cell-a', cellIncarnation: incarnation })
    ).rejects.toThrow('drain_recovery_too_early')
    now = 350_000
    await expect(
      store.prepareCellDrainRecovery({ attemptId, cellId: 'cell-a', cellIncarnation: incarnation })
    ).resolves.toEqual({
      shouldSend: true,
      retryAfter: 350_000
    })
    await expect(
      store.prepareCellDrainRecovery({ attemptId, cellId: 'cell-a', cellIncarnation: incarnation })
    ).resolves.toEqual({
      shouldSend: false,
      retryAfter: 350_000
    })
  })

  it('recovers a proven drain once after the source cell is replaced', async () => {
    let now = 100
    const store = await setupWithHeartbeats(() => now)
    const oldIncarnation = '11111111-1111-4111-8111-111111111111'
    const newIncarnation = '22222222-2222-4222-8222-222222222222'
    const newerIncarnation = '55555555-5555-4555-8555-555555555555'
    const attempt = {
      attemptId: '33333333-3333-4333-8333-333333333333',
      cellId: 'cell-a',
      cellIncarnation: oldIncarnation,
      traceValue: '44444444-4444-4444-8444-444444444444',
      plannedGraceMs: 120_000
    }
    await heartbeat(store)
    await store.setCellEnabled('cell-a', false)
    await store.prepareCellDrainAttempt(attempt)
    await store.beginCellDrainSend(attempt)
    now = 200
    await store.recordCellDrainApplicationReceipt({
      ...attempt,
      backendStatus: 200
    })

    now = 150_200
    await heartbeat(store, CELLS[0]!, {
      incarnation: newIncarnation,
      startedAt: 51
    })
    await expect(
      store.prepareCellDrainRecovery({
        cellId: 'cell-a',
        cellIncarnation: newIncarnation
      })
    ).resolves.toEqual({ shouldSend: true, retryAfter: 150_200 })
    await expect(
      store.prepareCellDrainRecovery({
        cellId: 'cell-a',
        cellIncarnation: newIncarnation
      })
    ).resolves.toEqual({ shouldSend: false, retryAfter: 150_200 })

    now = 150_300
    await heartbeat(store, CELLS[0]!, {
      incarnation: newerIncarnation,
      startedAt: 52
    })
    const concurrentRecoveries = await Promise.all([
      store.prepareCellDrainRecovery({
        cellId: 'cell-a',
        cellIncarnation: newerIncarnation
      }),
      store.prepareCellDrainRecovery({
        cellId: 'cell-a',
        cellIncarnation: newerIncarnation
      })
    ])
    expect(concurrentRecoveries.map((recovery) => recovery.shouldSend).sort()).toEqual([
      false,
      true
    ])
    await expect(
      store.prepareCellDrainRecovery({
        cellId: 'cell-a',
        cellIncarnation: newerIncarnation
      })
    ).resolves.toEqual({ shouldSend: false, retryAfter: 150_200 })
    await expect(
      database!.query(
        `SELECT cell_incarnation FROM relay_cell_drain_recovery_attempts
         WHERE drain_attempt_id = ? ORDER BY cell_incarnation`,
        [attempt.attemptId]
      )
    ).resolves.toEqual([
      { cell_incarnation: newIncarnation },
      { cell_incarnation: newerIncarnation }
    ])
  })

  it('rejects an invalid receipt and a prepared drain from an old incarnation', async () => {
    let now = 100
    const store = await setupWithHeartbeats(() => now)
    const oldIncarnation = '11111111-1111-4111-8111-111111111111'
    const newIncarnation = '22222222-2222-4222-8222-222222222222'
    const attempt = {
      attemptId: '33333333-3333-4333-8333-333333333333',
      cellId: 'cell-a',
      cellIncarnation: oldIncarnation,
      traceValue: '44444444-4444-4444-8444-444444444444',
      plannedGraceMs: 120_000
    }
    await heartbeat(store)
    await store.setCellEnabled('cell-a', false)
    await store.prepareCellDrainAttempt(attempt)
    now = 150_200
    await heartbeat(store, CELLS[0]!, {
      incarnation: newIncarnation,
      startedAt: 51
    })
    await expect(
      store.prepareCellDrainRecovery({
        cellId: 'cell-a',
        cellIncarnation: newIncarnation
      })
    ).rejects.toThrow('drain_application_receipt_missing')

    await database!.query(
      `UPDATE relay_cell_drain_attempt_states
       SET state = 'application-receipt', application_receipt_at = ?,
         receipt_cell_incarnation = ?, retry_after = ?
       WHERE attempt_id = ?`,
      [200, oldIncarnation, 150_200, attempt.attemptId]
    )
    await expect(
      store.prepareCellDrainRecovery({
        cellId: 'cell-a',
        cellIncarnation: newIncarnation
      })
    ).rejects.toThrow('drain_application_receipt_missing')
  })

  it('restores an expired registered migration lease before a prepared drain send', async () => {
    let now = 100
    const store = await setupWithHeartbeats(() => now)
    await heartbeat(store, CELLS[0]!)
    await heartbeat(store, CELLS[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222'
    })
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.assign(identity)
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    const attempt = {
      attemptId: '55555555-5555-4555-8555-555555555555',
      cellId: 'cell-a',
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      traceValue: '66666666-6666-4666-8666-666666666666',
      plannedGraceMs: 120_000
    }
    await store.prepareCellDrainAttempt(attempt)

    now = migration.expiresAt + 1
    expect(await store.releaseExpiredActivityLeases()).toBeGreaterThan(0)
    await heartbeat(store, CELLS[0]!)
    await heartbeat(store, CELLS[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222'
    })
    await expect(
      store.beginCellDrainSend({
        attemptId: attempt.attemptId,
        cellId: attempt.cellId,
        cellIncarnation: attempt.cellIncarnation
      })
    ).resolves.toMatchObject({
      state: 'send-may-have-started',
      shouldSend: true
    })
    await expect(
      database!.query(
        `SELECT activity_id, activity_kind, cell_id, request_units, expires_at
         FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).resolves.toContainEqual({
      activity_id: `migration:${migration.assignmentEpoch}`,
      activity_kind: 'migration',
      cell_id: 'cell-b',
      request_units: 1,
      expires_at: now + ASSIGNMENT_LIMITS.migrationLeaseMs
    })
  })

  it('refreshes registered migration leases before prepared drain recovery', async () => {
    let now = 100
    const cappedCells = CELLS.map((cell) => ({
      ...cell,
      connectionHardCap: 600 as const,
      connectionUnobservedBound: 50
    }))
    const store = await setupWithHeartbeats(() => now, cappedCells)
    await heartbeat(store, cappedCells[0]!)
    await heartbeat(store, cappedCells[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222'
    })
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.assign(identity)
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    const attempt = {
      attemptId: '99999999-9999-4999-8999-999999999999',
      cellId: 'cell-a',
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      traceValue: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      plannedGraceMs: 120_000
    }
    await store.prepareCellDrainAttempt(attempt)

    now = migration.expiresAt - 500_000
    await heartbeat(store, cappedCells[0]!)
    await heartbeat(store, cappedCells[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222'
    })
    await expect(store.prepareCellDrainRecovery(attempt)).resolves.toMatchObject({
      shouldSend: false,
      preparedAttempt: { attemptId: attempt.attemptId }
    })
    const refreshedExpiresAt = now + ASSIGNMENT_LIMITS.migrationLeaseMs
    await expect(
      database!.query(
        `SELECT expires_at FROM relay_assignment_migrations
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
        [identity.userId, identity.relayHostId, migration.assignmentEpoch]
      )
    ).resolves.toEqual([{ expires_at: refreshedExpiresAt }])
    await expect(
      database!.query(
        `SELECT state, timeout_at FROM relay_control_connection_reservations
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
        [identity.userId, identity.relayHostId, migration.assignmentEpoch]
      )
    ).resolves.toEqual([{ state: 'reserved', timeout_at: refreshedExpiresAt }])
  })

  it('bounds repeated accounting repair before prepared drain recovery', async () => {
    const delegate = await openInMemoryRelayDatabase()
    const retryDatabase = new RepeatedDrainAccountingFailureDatabase(delegate)
    database = retryDatabase
    const store = new RelayAssignmentStore(retryDatabase, () => 100, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    await store.reconcileCells(CELLS)
    await heartbeat(store, CELLS[0]!)
    await heartbeat(store, CELLS[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222'
    })
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.assign(identity)
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    const attempt = {
      attemptId: '99999999-9999-4999-8999-999999999999',
      cellId: 'cell-a',
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      traceValue: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      plannedGraceMs: 120_000
    }
    await store.prepareCellDrainAttempt(attempt)
    retryDatabase.arm(2)

    await expect(store.prepareCellDrainRecovery(attempt)).resolves.toMatchObject({
      shouldSend: false,
      preparedAttempt: { attemptId: attempt.attemptId }
    })
    expect(retryDatabase.refreshAttempts).toBe(3)

    retryDatabase.arm(4)
    await expect(store.prepareCellDrainRecovery(attempt)).rejects.toThrow(
      'migration_activity_accounting_mismatch'
    )
    expect(retryDatabase.refreshAttempts).toBe(4)
  })

  it('retires a pinned migration superseded by a newer authoritative assignment', async () => {
    let now = 100
    const cells = [
      ...CELLS,
      {
        id: 'cell-c',
        url: 'https://relay-c.example.com',
        capacityRequests: 2
      }
    ]
    const store = await setupWithHeartbeats(() => now, cells)
    await heartbeat(store, cells[0]!)
    await heartbeat(store, cells[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222'
    })
    await heartbeat(store, cells[2]!, {
      incarnation: '33333333-3333-4333-8333-333333333333'
    })
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.assign(identity)
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    const attempt = {
      attemptId: '99999999-9999-4999-8999-999999999999',
      cellId: 'cell-a',
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      traceValue: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      plannedGraceMs: 120_000
    }
    await store.prepareCellDrainAttempt(attempt)
    await store.beginCellDrainSend(attempt)
    const receipt = await store.recordCellDrainApplicationReceipt({
      ...attempt,
      backendStatus: 200
    })

    await database!.query(
      `DELETE FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    await database!.query(
      `UPDATE relay_assignments SET reserved_controls = 0, reserved_splices = 0,
         reserved_invites = 0, pending_installs = 0, pending_confirmations = 0,
         migration_leases = 0, lease_expires_at = 0, last_activity_at = 0
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    await database!.query(
      `UPDATE relay_cells SET reserved_requests = 0 WHERE cell_id IN (?, ?)`,
      ['cell-a', 'cell-b']
    )
    now = ASSIGNMENT_LIMITS.dormantTtlMs + 1
    await heartbeat(store, cells[2]!, {
      incarnation: '33333333-3333-4333-8333-333333333333'
    })
    const current = await store.rebalanceDormant(identity, 'cell-c')
    await store.activateControl(identity, {
      cellId: 'cell-c',
      assignmentEpoch: current.assignmentEpoch,
      generation: 1
    })

    expect(receipt.retryAfter).toBeLessThanOrEqual(now)
    await heartbeat(store, cells[0]!)
    await expect(store.prepareCellDrainRecovery(attempt)).resolves.toMatchObject({
      shouldSend: true
    })
    await expect(
      database!.query(
        `SELECT aborted_at FROM relay_assignment_migrations
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
        [identity.userId, identity.relayHostId, migration.assignmentEpoch]
      )
    ).resolves.toEqual([{ aborted_at: now }])
    await expect(
      database!.query(
        `SELECT cell_id, assignment_epoch FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).resolves.toEqual([
      { cell_id: 'cell-c', assignment_epoch: current.assignmentEpoch }
    ])
    await expect(
      database!.query(
        `SELECT activity_id, cell_id FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).resolves.toEqual([{ activity_id: 'control:cell-c:1', cell_id: 'cell-c' }])
  })

  it('refuses to restore a missing migration lease without durable target registration', async () => {
    let now = 100
    const store = await setupWithHeartbeats(() => now)
    await heartbeat(store, CELLS[0]!)
    await heartbeat(store, CELLS[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222'
    })
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.assign(identity)
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    const attempt = {
      attemptId: '77777777-7777-4777-8777-777777777777',
      cellId: 'cell-a',
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      traceValue: '88888888-8888-4888-8888-888888888888',
      plannedGraceMs: 120_000
    }
    await store.prepareCellDrainAttempt(attempt)

    now = migration.expiresAt + 1
    expect(await store.releaseExpiredActivityLeases()).toBeGreaterThan(0)
    await heartbeat(store, CELLS[0]!)
    await heartbeat(store, CELLS[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222'
    })
    await expect(
      store.beginCellDrainSend({
        attemptId: attempt.attemptId,
        cellId: attempt.cellId,
        cellIncarnation: attempt.cellIncarnation
      })
    ).rejects.toThrow('migration_activity_lease_shape_mismatch')
  })

  it('moves a dead assignment only after a completed exact-incarnation fence attempt', async () => {
    let now = 100
    const cappedCells = CELLS.map((cell) => ({
      ...cell,
      connectionHardCap: 600 as const,
      connectionUnobservedBound: 50
    }))
    const store = await setupWithHeartbeats(() => now, cappedCells)
    await heartbeat(store, cappedCells[0]!)
    await heartbeat(store, cappedCells[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222'
    })
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.assign(identity)
    await store.setCellEnabled('cell-a', false)
    now += 45_001
    await heartbeat(store, cappedCells[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222'
    })

    await store.attestCellFence('cell-a', '11111111-1111-4111-8111-111111111111')
    expect(
      await database!.query(
        `SELECT cell_id FROM relay_cell_legacy_fence_adoptions WHERE cell_id = ?`,
        ['cell-a']
      )
    ).toEqual([])
    expect(await store.evacuateDeadCells()).toBe(0)
    expect(
      await database!.query(
        `SELECT cell_id FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ cell_id: 'cell-a' }])

    now += 300_001
    await heartbeat(store, cappedCells[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222'
    })
    const evidence = {
      attemptId: '22222222-2222-4222-8222-222222222222',
      environment: 'production' as const,
      cellId: 'cell-a',
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      migName: 'orca-relay-c1',
      instanceGroup: 'https://compute.example/instanceGroups/orca-relay-c1',
      generationIdentity: 'https://compute.example/instanceTemplates/orca-relay-c1-abc',
      fenceCommit: 'a'.repeat(40),
      planSha256: 'b'.repeat(64),
      ...FENCE_PLAN_BINDING
    }
    await store.prepareCellFenceAttempt(evidence)
    await store.bindCellFencePlanGeneration(evidence, evidence.planObjectGeneration)
    await store.startCellFenceApply(
      evidence,
      FENCE_INVOCATION_ID,
      FENCE_INVOCATION_REASON
    )
    await store.recordCellFenceOperation(
      evidence,
      FENCE_INVOCATION_ID,
      FENCE_INVOCATION_REASON,
      'operation-1'
    )
    await store.attestCellFenceAttempt(evidence, 'operation-1')

    expect(await store.evacuateDeadCells()).toBe(1)
    expect((await store.resolve(identity))?.cellId).toBe('cell-b')
  })

  it('preserves proven non-delivery and permits one fresh full-grace attempt', async () => {
    const store = await setupWithHeartbeats(() => 100, [CELLS[0]!])
    await heartbeat(store)
    await store.setCellEnabled('cell-a', false)
    const first = {
      attemptId: '33333333-3333-4333-8333-333333333333',
      cellId: 'cell-a',
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      traceValue: '44444444-4444-4444-8444-444444444444',
      plannedGraceMs: 120_000
    }
    await store.prepareCellDrainAttempt(first)
    await store.beginCellDrainSend(first)
    await expect(store.proveCellDrainNotDelivered(first)).resolves.toMatchObject({
      state: 'proven-not-delivered',
      provenNotDeliveredAt: 100
    })
    await expect(
      store.prepareCellDrainAttempt({
        ...first,
        attemptId: '55555555-5555-4555-8555-555555555555',
        traceValue: '66666666-6666-4666-8666-666666666666'
      })
    ).resolves.toMatchObject({ state: 'prepared' })
  })

  it('binds fence attestation to one durable Terraform attempt', async () => {
    let now = 100
    const store = await setupWithHeartbeats(() => now, [CELLS[0]!])
    await heartbeat(store)
    await store.setCellEnabled('cell-a', false)
    const evidence = {
      attemptId: '22222222-2222-4222-8222-222222222222',
      environment: 'production' as const,
      cellId: 'cell-a',
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      migName: 'orca-relay-c1',
      instanceGroup: 'https://compute.example/instanceGroups/orca-relay-c1',
      generationIdentity: 'https://compute.example/instanceTemplates/orca-relay-c1-abc',
      fenceCommit: 'a'.repeat(40),
      planSha256: 'b'.repeat(64),
      ...FENCE_PLAN_BINDING
    }
    const prepared = await store.prepareCellFenceAttempt(evidence)
    expect(prepared).toMatchObject({ createdAt: 100, expiresAt: 3_600_100 })
    expect(prepared.planObjectGeneration).toBeUndefined()
    await expect(
      store.bindCellFencePlanGeneration(
        evidence,
        evidence.planObjectGeneration
      )
    ).resolves.toMatchObject({
      planObjectGeneration: evidence.planObjectGeneration
    })
    await expect(
      store.bindCellFencePlanGeneration(
        evidence,
        evidence.planObjectGeneration
      )
    ).resolves.toMatchObject({
      planObjectGeneration: evidence.planObjectGeneration
    })
    await expect(
      store.bindCellFencePlanGeneration(
        evidence,
        '987654321'
      )
    ).rejects.toThrow('cell_fence_plan_generation_mismatch')
    for (const changed of [
      { attemptId: '33333333-3333-4333-8333-333333333333' },
      { environment: 'staging' as const },
      { cellId: 'cell-b' },
      { cellIncarnation: '33333333-3333-4333-8333-333333333333' },
      { migName: 'orca-relay-other' },
      { instanceGroup: `${evidence.instanceGroup}-other` },
      { generationIdentity: `${evidence.generationIdentity}-other` },
      { fenceCommit: 'c'.repeat(40) },
      { planSha256: 'c'.repeat(64) }
    ]) {
      await expect(
        store.startCellFenceApply(
          { ...evidence, ...changed },
          FENCE_INVOCATION_ID,
          FENCE_INVOCATION_REASON
        )
      ).rejects.toThrow()
    }
    await store.startCellFenceApply(
      evidence,
      FENCE_INVOCATION_ID,
      FENCE_INVOCATION_REASON
    )
    await store.recordCellFenceOperation(
      evidence,
      FENCE_INVOCATION_ID,
      FENCE_INVOCATION_REASON,
      'operation-1'
    )
    now += 45_001
    await expect(
      store.attestCellFenceAttempt(evidence, 'operation-other')
    ).rejects.toThrow('cell_fence_operation_not_attested')
    const attested = await store.attestCellFenceAttempt(evidence, 'operation-1')
    expect(attested).toMatchObject({
      expiresAt: now + 300_000,
      attempt: { ...evidence, gceOperation: 'operation-1', completedAt: now }
    })
    await expect(store.attestCellFenceAttempt(evidence, 'operation-1')).resolves.toEqual(
      attested
    )
    now += 300_001
    await expect(
      store.attestCellFenceAttempt(evidence, 'operation-1')
    ).resolves.toMatchObject({
      expiresAt: now + 300_000,
      attempt: { completedAt: attested.attempt.completedAt }
    })
  })

  it('aborts only a Terraform fence whose apply never started', async () => {
    const store = await setupWithHeartbeats(() => 100, [CELLS[0]!])
    await heartbeat(store)
    await store.setCellEnabled('cell-a', false)
    const evidence = {
      attemptId: '22222222-2222-4222-8222-222222222222',
      environment: 'production' as const,
      cellId: 'cell-a',
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      migName: 'orca-relay-c1',
      instanceGroup: 'https://compute.example/instanceGroups/orca-relay-c1',
      generationIdentity: 'https://compute.example/instanceTemplates/orca-relay-c1-abc',
      fenceCommit: 'a'.repeat(40),
      planSha256: 'b'.repeat(64),
      ...FENCE_PLAN_BINDING
    }
    await store.prepareCellFenceAttempt(evidence)
    await store.bindCellFencePlanGeneration(
      evidence,
      evidence.planObjectGeneration
    )
    await expect(store.abortCellFenceAttempt(evidence)).resolves.toMatchObject({
      abortedAt: 100
    })
    await expect(
      store.startCellFenceApply(
        evidence,
        FENCE_INVOCATION_ID,
        FENCE_INVOCATION_REASON
      )
    ).rejects.toThrow(
      'cell_fence_attempt_aborted'
    )
  })

  it('adopts a stale disabled legacy fence only when no durable attempt exists', async () => {
    let now = 100
    const store = await setupWithHeartbeats(() => now, [CELLS[0]!])
    await heartbeat(store)
    await store.setCellEnabled('cell-a', false)
    now += 45_001

    await expect(
      store.adoptLegacyCellFence('cell-a', '11111111-1111-4111-8111-111111111111')
    ).resolves.toBe(now + 300_000)
    await expect(
      database!.query(
        `SELECT cell_id, cell_incarnation FROM relay_cell_fences WHERE cell_id = ?`,
        ['cell-a']
      )
    ).resolves.toEqual([
      {
        cell_id: 'cell-a',
        cell_incarnation: '11111111-1111-4111-8111-111111111111'
      }
    ])
    await expect(
      database!.query(
        `SELECT cell_id, cell_incarnation
         FROM relay_cell_legacy_fence_adoptions WHERE cell_id = ?`,
        ['cell-a']
      )
    ).resolves.toEqual([])
    await store.commitLegacyCellFenceAdoption(
      'cell-a',
      '11111111-1111-4111-8111-111111111111'
    )
    await expect(
      database!.query(
        `SELECT cell_id, cell_incarnation
         FROM relay_cell_legacy_fence_adoptions WHERE cell_id = ?`,
        ['cell-a']
      )
    ).resolves.toEqual([
      {
        cell_id: 'cell-a',
        cell_incarnation: '11111111-1111-4111-8111-111111111111'
      }
    ])

    now += 1
    await expect(
      store.adoptLegacyCellFence('cell-a', '11111111-1111-4111-8111-111111111111')
    ).resolves.toBe(now + 300_000)
    await store.commitLegacyCellFenceAdoption(
      'cell-a',
      '11111111-1111-4111-8111-111111111111'
    )
    await expect(
      database!.query(
        `SELECT attested_at, expires_at
         FROM relay_cell_legacy_fence_adoptions WHERE cell_id = ?`,
        ['cell-a']
      )
    ).resolves.toEqual([{ attested_at: now, expires_at: now + 300_000 }])

    await heartbeat(store)
    await expect(
      database!.query(
        `SELECT cell_id FROM relay_cell_legacy_fence_adoptions WHERE cell_id = ?`,
        ['cell-a']
      )
    ).resolves.toEqual([])
  })

  it.each(['active', 'completed', 'aborted'] as const)(
    'rejects legacy adoption after a %s durable attempt',
    async (status) => {
      let now = 100
      const store = await setupWithHeartbeats(() => now, [CELLS[0]!])
      await heartbeat(store)
      await store.setCellEnabled('cell-a', false)
      const evidence = cellFenceEvidence()
      await store.prepareCellFenceAttempt(evidence)
      if (status === 'aborted') await store.abortCellFenceAttempt(evidence)
      if (status === 'completed') {
        await store.bindCellFencePlanGeneration(evidence, evidence.planObjectGeneration)
        await store.startCellFenceApply(
          evidence,
          FENCE_INVOCATION_ID,
          FENCE_INVOCATION_REASON
        )
        await store.recordCellFenceOperation(
          evidence,
          FENCE_INVOCATION_ID,
          FENCE_INVOCATION_REASON,
          'operation-1'
        )
      }
      now += 45_001
      if (status === 'completed') {
        await store.attestCellFenceAttempt(evidence, 'operation-1')
      }

      await expect(
        store.adoptLegacyCellFence('cell-a', '11111111-1111-4111-8111-111111111111')
      ).rejects.toThrow('legacy_cell_fence_attempt_exists')
    }
  )

  it('serializes legacy adoption against durable attempt preparation', async () => {
    let now = 100
    const store = await setupWithHeartbeats(() => now, [CELLS[0]!])
    await heartbeat(store)
    await store.setCellEnabled('cell-a', false)
    now += 45_001

    const results = await Promise.allSettled([
      store.adoptLegacyCellFence('cell-a', '11111111-1111-4111-8111-111111111111'),
      store.prepareCellFenceAttempt(cellFenceEvidence())
    ])
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const attempts = await database!.query(
      `SELECT COUNT(*) AS count FROM relay_cell_fence_attempts WHERE cell_id = ?`,
      ['cell-a']
    )
    const fences = await database!.query(
      `SELECT COUNT(*) AS count FROM relay_cell_fences WHERE cell_id = ?`,
      ['cell-a']
    )
    const adoptions = await database!.query(
      `SELECT COUNT(*) AS count FROM relay_cell_legacy_fence_adoptions
       WHERE cell_id = ?`,
      ['cell-a']
    )
    expect(Number(attempts[0]!.count) + Number(fences[0]!.count)).toBe(1)
    expect(Number(adoptions[0]!.count)).toBe(0)
  })

  it('rejects an expired durable Terraform fence attempt', async () => {
    let now = 100
    const store = await setupWithHeartbeats(() => now, [CELLS[0]!])
    await heartbeat(store)
    await store.setCellEnabled('cell-a', false)
    const evidence = {
      attemptId: '22222222-2222-4222-8222-222222222222',
      environment: 'production' as const,
      cellId: 'cell-a',
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      migName: 'orca-relay-c1',
      instanceGroup: 'https://compute.example/instanceGroups/orca-relay-c1',
      generationIdentity: 'https://compute.example/instanceTemplates/orca-relay-c1-abc',
      fenceCommit: 'a'.repeat(40),
      planSha256: 'b'.repeat(64),
      ...FENCE_PLAN_BINDING
    }
    await store.prepareCellFenceAttempt(evidence)
    await store.bindCellFencePlanGeneration(
      evidence,
      evidence.planObjectGeneration
    )
    now += 3_600_001
    await expect(
      store.startCellFenceApply(
        evidence,
        FENCE_INVOCATION_ID,
        FENCE_INVOCATION_REASON
      )
    ).rejects.toThrow(
      'cell_fence_attempt_expired'
    )
  })

  it('keeps a started Terraform fence attempt recoverable after its preparation TTL', async () => {
    let now = 100
    const store = await setupWithHeartbeats(() => now, [CELLS[0]!])
    await heartbeat(store)
    await store.setCellEnabled('cell-a', false)
    const evidence = {
      attemptId: '22222222-2222-4222-8222-222222222222',
      environment: 'production' as const,
      cellId: 'cell-a',
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      migName: 'orca-relay-c1',
      instanceGroup: 'https://compute.example/instanceGroups/orca-relay-c1',
      generationIdentity: 'https://compute.example/instanceTemplates/orca-relay-c1-abc',
      fenceCommit: 'a'.repeat(40),
      planSha256: 'b'.repeat(64),
      ...FENCE_PLAN_BINDING
    }
    await store.prepareCellFenceAttempt(evidence)
    await store.bindCellFencePlanGeneration(
      evidence,
      evidence.planObjectGeneration
    )
    await store.startCellFenceApply(
      evidence,
      FENCE_INVOCATION_ID,
      FENCE_INVOCATION_REASON
    )
    now += 3_600_001
    await expect(
      store.recordCellFenceOperation(
        evidence,
        FENCE_INVOCATION_ID,
        FENCE_INVOCATION_REASON,
        'operation-1'
      )
    ).resolves.toMatchObject({
      attempt: { gceOperation: 'operation-1' },
      invocation: { gceOperation: 'operation-1' }
    })
    await expect(
      store.prepareCellFenceAttempt({
        ...evidence,
        attemptId: '44444444-4444-4444-8444-444444444444',
        planObjectName:
          'terraform/state/relay-fence-plans/production/44444444-4444-4444-8444-444444444444.tfplan',
        requestReason:
          'orca-relay-fence/44444444-4444-4444-8444-444444444444'
      })
    ).rejects.toThrow('cell_fence_attempt_evidence_mismatch')
  })

  it('reports aggregate deployment state and heartbeat freshness without identities', async () => {
    let now = 100
    const store = await setupWithHeartbeats(() => now, [CELLS[0]!])
    await heartbeat(store)
    const identity = { userId: 'private-user', relayHostId: 'host000000000001' }
    const assignment = await store.assign(identity)
    expect(await store.cellDeploymentStatus('cell-a')).toMatchObject({
      activityLeases: 1,
      activityRequestUnits: 1,
      restartBlockingActivityLeases: 0,
      restartBlockingActivityRequestUnits: 0,
      restartBlockingReservedRequests: 0
    })
    await store.activateControl(identity, {
      cellId: 'cell-a',
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })

    expect(await store.cellDeploymentStatus('cell-a')).toEqual({
      cellId: 'cell-a',
      cellUrl: 'https://relay-a.example.com',
      region: 'us-central1',
      enabled: true,
      admissionState: 'general',
      capacityRequests: 2,
      reservedRequests: 1,
      assignments: 1,
      activityLeases: 1,
      activityRequestUnits: 1,
      restartBlockingActivityLeases: 1,
      restartBlockingActivityRequestUnits: 1,
      restartBlockingReservedRequests: 1,
      outgoingMigrations: 0,
      incomingMigrations: 0,
      connectionCapacity: null,
      runtime: {
        cellUrl: 'https://relay-a.example.com',
        cellIncarnation: '11111111-1111-4111-8111-111111111111',
        startedAt: 50,
        ready: true,
        observedRequests: 0,
        lastHeartbeatAt: 100,
        heartbeatFresh: true,
        regionalRehomeProtocol: 0
      }
    })
    now += 45_001
    expect((await store.cellDeploymentStatus('cell-a')).runtime?.heartbeatFresh).toBe(false)
    await expect(store.cellDeploymentStatus('missing')).rejects.toThrow('cell_not_found')
  })

  it('keeps concurrent sticky assignment grants restart-safe', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 }
    ])
    const identity = { userId: 'private-user', relayHostId: 'host000000000001' }

    await Promise.all(Array.from({ length: 20 }, async () => await store.assign(identity)))

    expect(await store.cellDeploymentStatus('cell-a')).toMatchObject({
      activityLeases: 1,
      activityRequestUnits: 1,
      reservedRequests: 1,
      restartBlockingActivityLeases: 0,
      restartBlockingActivityRequestUnits: 0,
      restartBlockingReservedRequests: 0
    })
  })

  it('classifies activated and non-control activity as restart-blocking', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 }
    ])
    const identity = { userId: 'private-user', relayHostId: 'host000000000001' }
    const assignment = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: assignment.cellId,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    for (const kind of ['splice', 'invite', 'install', 'confirmation', 'migration'] as const) {
      await store.acquireActivity(identity, {
        activityId: `${kind}:test`,
        kind,
        cellId: assignment.cellId
      })
    }

    expect(await store.cellDeploymentStatus('cell-a')).toMatchObject({
      activityLeases: 6,
      activityRequestUnits: 7,
      reservedRequests: 7,
      restartBlockingActivityLeases: 6,
      restartBlockingActivityRequestUnits: 7,
      restartBlockingReservedRequests: 7
    })
  })

  it('fails closed for malformed pending controls and unexplained reservations', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 }
    ])
    await store.assign({ userId: 'private-user', relayHostId: 'host000000000001' })
    await database!.query(
      `UPDATE relay_assignment_activity_leases SET request_units = 2
       WHERE cell_id = ?`,
      ['cell-a']
    )
    expect(await store.cellDeploymentStatus('cell-a')).toMatchObject({
      restartBlockingActivityLeases: 1,
      restartBlockingActivityRequestUnits: 2,
      restartBlockingReservedRequests: 1
    })

    await database!.query(
      `UPDATE relay_assignment_activity_leases SET request_units = 1 WHERE cell_id = ?`,
      ['cell-a']
    )
    await database!.query(
      `UPDATE relay_cells SET reserved_requests = 0 WHERE cell_id = ?`,
      ['cell-a']
    )
    expect(await store.cellDeploymentStatus('cell-a')).toMatchObject({
      restartBlockingActivityLeases: 0,
      restartBlockingActivityRequestUnits: 0,
      restartBlockingReservedRequests: -1
    })

    await database!.query(
      `UPDATE relay_cells SET reserved_requests = 2 WHERE cell_id = ?`,
      ['cell-a']
    )
    expect(await store.cellDeploymentStatus('cell-a')).toMatchObject({
      restartBlockingActivityLeases: 0,
      restartBlockingActivityRequestUnits: 0,
      restartBlockingReservedRequests: 1
    })
  })

  it('keeps a migration blocking when its target also has a pending control', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 20 }
    ])
    const identity = { userId: 'private-user', relayHostId: 'host000000000001' }
    await store.assign(identity)
    await store.startEvacuation(identity, 'cell-b')

    expect(await store.cellDeploymentStatus('cell-b')).toMatchObject({
      activityLeases: 2,
      restartBlockingActivityLeases: 1,
      restartBlockingActivityRequestUnits: 1,
      restartBlockingReservedRequests: 1,
      incomingMigrations: 1
    })
  })

  it('starts declared candidates disabled without overwriting later operator state', async () => {
    const candidate: RelayCellConfig = {
      id: 'candidate',
      url: 'https://candidate.example.com',
      capacityRequests: 20,
      initiallyEnabled: false
    }
    const store = await setup(() => 100, [candidate])
    expect((await store.cellDeploymentStatus('candidate')).enabled).toBe(false)
    await store.setCellEnabled('candidate', true)
    await store.reconcileCells([candidate])
    expect((await store.cellDeploymentStatus('candidate')).enabled).toBe(true)
  })

  it('moves a stranded host off an existing-only cell that stopped serving it', async () => {
    // Why: C3's decommission created an existing-only cell that rejects
    // attaches; the #194 pin then loops returning hosts forever while each
    // grant refreshes their own activity (issue #225). C3 has no
    // connection-limits row and expired leases are cleaned within a
    // maintenance cycle, so the only durable evidence is the assignment row:
    // a recent grant with no live real activity behind it.
    let now = 100
    const store = await setup(() => now)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.setCellEnabled(first.cellId, false)

    // The pin holds while the last grant is young enough to still attach.
    now += 10_000
    const pinned = await store.assign(identity)
    expect(pinned.cellId).toBe(first.cellId)

    // The grant had ample time to attach and produced nothing live.
    now += 61_000
    const moved = await store.assign(identity)
    expect(moved.cellId).not.toBe(first.cellId)
    expect(moved.assignmentEpoch).toBe(first.assignmentEpoch + 1)

    // The move is durable: no bounce back to the closed cell.
    now += 1_000
    const settled = await store.assign(identity)
    expect(settled.cellId).toBe(moved.cellId)
    expect(settled.assignmentEpoch).toBe(moved.assignmentEpoch)
  })

  it('keeps a serving existing-only cell pinned for hosts with live activity', async () => {
    let now = 100
    const store = await setup(() => now)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.setCellEnabled(first.cellId, false)
    // A live claimed control proves the cell still serves this host.
    await database!.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, ?, 'control', ?, 1, ?, ?)`,
      [identity.userId, identity.relayHostId, 'control:live-1', first.cellId, now + 600_000, now]
    )
    now += 61_000
    const pinned = await store.assign(identity)
    expect(pinned.cellId).toBe(first.cellId)
  })

  it('keeps migration-only cells pinned inside the stranded window', async () => {
    let now = 100
    const store = await setup(() => now)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.setCellAdmissionState(first.cellId, 'migration-only')
    now += 61_000
    const pinned = await store.assign(identity)
    expect(pinned.cellId).toBe(first.cellId)
  })

  it('leaves quiet existing-only assignments to the normal dormancy rule', async () => {
    // Why: outside the 15-minute stranded window there is no active retry
    // loop to break; ordinary returns stay pinned until 24h dormancy.
    let now = 100
    const store = await setup(() => now)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.setCellEnabled(first.cellId, false)
    now += 20 * 60_000
    const pinned = await store.assign(identity)
    expect(pinned.cellId).toBe(first.cellId)
  })

  it('reassigns an active assignment from an uncapped stale cell without a fence', async () => {
    let now = 100
    const store = await setupWithHeartbeats(() => now)
    await heartbeat(store, CELLS[0]!)
    await heartbeat(store, CELLS[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222'
    })
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.changeActivity(identity, 'invite', 1)
    await database!.query(
      `INSERT INTO relay_assignment_migrations
       (user_id, relay_host_id, source_cell_id, target_cell_id,
        previous_epoch, assignment_epoch, source_request_units,
        target_reserved_units, expires_at, target_registered_at,
        completed_at, aborted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      [
        identity.userId,
        identity.relayHostId,
        'cell-b',
        'cell-a',
        -1,
        0,
        0,
        1,
        90_100,
        now,
        now
      ]
    )
    await database!.query(
      `INSERT INTO relay_post_drain_migration_pins
       (user_id, relay_host_id, assignment_epoch, drain_attempt_id,
        source_cell_id, source_cell_incarnation, target_cell_id,
        target_cell_incarnation, source_request_units, target_reserved_units,
        pinned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity.userId,
        identity.relayHostId,
        0,
        '33333333-3333-4333-8333-333333333333',
        'cell-b',
        '22222222-2222-4222-8222-222222222222',
        'cell-a',
        '11111111-1111-4111-8111-111111111111',
        0,
        1,
        now
      ]
    )

    now += 45_001
    await heartbeat(store, CELLS[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222'
    })
    expect(await store.evacuateDeadCells()).toBe(1)
    const replacement = await store.resolve(identity)
    expect(replacement).toMatchObject({
      cellId: 'cell-b',
      assignmentEpoch: first.assignmentEpoch + 1
    })
    expect(
      await database!.query(
        `SELECT activity_kind, cell_id FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ activity_kind: 'control', cell_id: 'cell-b' }])
  })

  it('does not let an unfenced capped cell starve eligible legacy recovery', async () => {
    let now = 100
    const cells: RelayCellConfig[] = [
      {
        id: 'cell-a',
        url: 'https://relay-a.example.com',
        capacityRequests: 10,
        connectionHardCap: 600,
        connectionUnobservedBound: 50
      },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 },
      { id: 'cell-c', url: 'https://relay-c.example.com', capacityRequests: 10 }
    ]
    const store = await setupWithHeartbeats(() => now, cells)
    for (const cell of cells) await heartbeat(store, cell)
    await store.setCellEnabled('cell-b', false)
    await store.setCellEnabled('cell-c', false)
    const cappedIdentity = { userId: 'a-capped', relayHostId: 'host000000000001' }
    expect(await store.assign(cappedIdentity)).toMatchObject({ cellId: 'cell-a' })

    await store.setCellEnabled('cell-a', false)
    await store.setCellEnabled('cell-b', true)
    const legacyIdentity = { userId: 'z-legacy', relayHostId: 'host000000000002' }
    expect(await store.assign(legacyIdentity)).toMatchObject({ cellId: 'cell-b' })
    await store.setCellEnabled('cell-c', true)

    now += 45_001
    await heartbeat(store, cells[2]!)
    expect(await store.evacuateDeadCells(1)).toBe(1)
    expect(await store.resolve(legacyIdentity)).toMatchObject({ cellId: 'cell-c' })
    expect(
      await database!.query(
        `SELECT cell_id FROM relay_assignments WHERE user_id = ?`,
        [cappedIdentity.userId]
      )
    ).toEqual([{ cell_id: 'cell-a' }])
  })

  it('refuses evacuation into a cell without a fresh ready heartbeat', async () => {
    const store = await setupWithHeartbeats(() => 100)
    await heartbeat(store, CELLS[0]!)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.assign(identity)

    await expect(store.startEvacuation(identity, 'cell-b')).rejects.toThrow(
      'target_cell_unavailable'
    )
  })

  it('keeps an active assignment sticky without increasing its epoch or reservation', async () => {
    const store = await setup(() => 100)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const second = await store.assign(identity)

    expect(second).toEqual(first)
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 1, 'cell-b': 0 })
  })

  it('selects the least-loaded cell with a stable cell-id tie break', async () => {
    const store = await setup(() => 100)
    const first = await store.assign({ userId: 'user-a', relayHostId: 'host000000000001' })
    const second = await store.assign({ userId: 'user-b', relayHostId: 'host000000000002' })

    expect([first.cellId, second.cellId]).toEqual(['cell-a', 'cell-b'])
  })

  it('admits exactly through the configured capacity boundary', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 2 }
    ])
    await store.assign({ userId: 'user-a', relayHostId: 'host000000000001' })
    await store.assign({ userId: 'user-b', relayHostId: 'host000000000002' })

    await expect(
      store.assign({ userId: 'user-c', relayHostId: 'host000000000003' })
    ).rejects.toThrow('relay_capacity_exhausted')
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 2 })
  })

  it('does not oversubscribe when assignments race', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 2 }
    ])
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        store.assign({ userId: `user-${index}`, relayHostId: `host${String(index).padStart(12, '0')}` })
      )
    )

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(2)
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 2 })
  })

  it('reassigns only after all activity expires and the dormant TTL elapses', async () => {
    let now = 100
    const store = await setup(() => now)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.changeActivity(identity, 'invite', 1)
    await store.changeActivity(identity, 'control', -1)

    now += ASSIGNMENT_LIMITS.activityLeaseMs + 1
    await store.releaseExpiredActivityLeases()
    await store.releaseExpiredActivity()
    await database!.query(`UPDATE relay_cells SET observed_requests = 2 WHERE cell_id = ?`, [
      first.cellId
    ])
    now += ASSIGNMENT_LIMITS.dormantTtlMs
    const reassigned = await store.assign(identity)

    expect(reassigned.cellId).not.toBe(first.cellId)
    expect(reassigned.assignmentEpoch).toBe(first.assignmentEpoch + 1)
  })

  it('will not normally move an assignment while any durable activity remains', async () => {
    let now = 100
    const store = await setup(() => now)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.changeActivity(identity, 'migration', 1)
    await store.changeActivity(identity, 'control', -1)
    await database!.query(`UPDATE relay_cells SET observed_requests = 2 WHERE cell_id = ?`, [
      first.cellId
    ])
    now += ASSIGNMENT_LIMITS.dormantTtlMs + 1

    expect(await store.assign(identity)).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })
  })

  it('releases every expired activity reservation without going negative', async () => {
    let now = 100
    const store = await setup(() => now, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 }
    ])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.assign(identity)
    for (const kind of ['splice', 'invite', 'install', 'confirmation', 'migration'] as const) {
      await store.changeActivity(identity, kind, 1)
    }
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 7 })

    now += ASSIGNMENT_LIMITS.activityLeaseMs + 1
    expect(await store.releaseExpiredActivityLeases()).toBe(1)
    expect(await store.releaseExpiredActivity()).toBe(1)
    expect(await store.releaseExpiredActivity()).toBe(0)
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 0 })
  })

  it('isolates assignments by host and verifies both cell and epoch', async () => {
    const store = await setup(() => 100)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const assignment = await store.assign(identity)

    await expect(
      store.verifyCellAssignment({ ...identity, cellId: assignment.cellId, assignmentEpoch: 1 })
    ).resolves.toBe(true)
    await expect(
      store.verifyCellAssignment({ ...identity, cellId: 'cell-b', assignmentEpoch: 1 })
    ).resolves.toBe(false)
    await expect(
      store.verifyCellAssignment({ ...identity, cellId: assignment.cellId, assignmentEpoch: 2 })
    ).resolves.toBe(false)
    await expect(
      store.resolve({ userId: 'other', relayHostId: identity.relayHostId })
    ).resolves.toBeNull()
  })

  it('converts the director reservation into an idempotent active-control lease', async () => {
    const store = await setup(() => 100)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const assignment = await store.assign(identity)

    const activityId = await store.activateControl(identity, {
      cellId: assignment.cellId,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    await store.activateControl(identity, {
      cellId: assignment.cellId,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })

    expect(activityId).toBe(`control:${assignment.cellId}:1`)
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 1, 'cell-b': 0 })
    const leases = await database!.query(
      `SELECT activity_id FROM relay_assignment_activity_leases`
    )
    expect(leases).toEqual([{ activity_id: activityId }])
  })

  it('transactionally supersedes older controls on only the same cell', async () => {
    const cells = [
      {
        id: 'cell-a',
        url: 'https://relay-a.example.com',
        capacityRequests: 10
      },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const store = await setup(() => 100, cells)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.setCellEnabled('cell-b', false)
    const assignment = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: assignment.cellId,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    await store.setCellEnabled('cell-b', true)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await database!.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, ?, 'control', 'cell-b', 1, 90100, 100),
              (?, ?, ?, 'control', 'cell-b', 1, 90100, 100)`,
      [
        identity.userId,
        identity.relayHostId,
        'control:cell-b:2',
        identity.userId,
        identity.relayHostId,
        'control:cell-b:3'
      ]
    )
    const latest = await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 4
    })

    expect(
      await database!.query(
        `SELECT activity_id, cell_id FROM relay_assignment_activity_leases
         WHERE activity_kind = 'control' ORDER BY cell_id`
      )
    ).toEqual([
      { activity_id: 'control:cell-a:1', cell_id: 'cell-a' },
      { activity_id: latest, cell_id: 'cell-b' }
    ])
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 1, 'cell-b': 2 })
    expect(
      await database!.query(
        `SELECT reserved_controls FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ reserved_controls: 2 }])
  })

  it('re-reserves a sticky grant for a host holding no control lease', async () => {
    const store = await setup(() => 100)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const assignment = await store.assign(identity)
    const control = await store.activateControl(identity, {
      cellId: assignment.cellId,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    await store.releaseActivity(identity, control)
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 0, 'cell-b': 0 })

    await expect(store.assign(identity)).resolves.toMatchObject({
      cellId: assignment.cellId,
      assignmentEpoch: assignment.assignmentEpoch
    })
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 1, 'cell-b': 0 })
    expect(
      await database!.query(
        `SELECT activity_id FROM relay_assignment_activity_leases`
      )
    ).toEqual([{ activity_id: 'control-pending:1' }])
    expect(
      await database!.query(
        `SELECT reserved_controls FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ reserved_controls: 1 }])
  })

  it('re-pins a host that took control after the sticky lane read it dormant', async () => {
    const now = 100
    const delegate = await openInMemoryRelayDatabase()
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const seeded = new SeedBetweenAssignmentLanesDatabase(delegate, async () => {
      await delegate.query(
        `INSERT INTO relay_assignment_activity_leases
         (user_id, relay_host_id, activity_id, activity_kind, cell_id,
          request_units, expires_at, updated_at)
         VALUES (?, ?, 'control:cell-a:1', 'control', 'cell-a', 1, ?, ?),
                (?, ?, 'control-pending:1', 'control', 'cell-a', 1, ?, ?)`,
        [
          identity.userId,
          identity.relayHostId,
          now + ASSIGNMENT_LIMITS.activityLeaseMs,
          now,
          identity.userId,
          identity.relayHostId,
          now + ASSIGNMENT_LIMITS.activityLeaseMs,
          now
        ]
      )
      await delegate.query(
        `UPDATE relay_assignments SET reserved_controls = 2
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
      await delegate.query(
        `UPDATE relay_cells SET reserved_requests = 2 WHERE cell_id = 'cell-a'`
      )
    })
    database = seeded
    const store = new RelayAssignmentStore(seeded, () => now)
    await store.reconcileCells(CELLS)
    await delegate.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, 'cell-a', 1, ?, ?, 0, 0, 0, 0, 0, 0)`,
      [identity.userId, identity.relayHostId, now, now - ASSIGNMENT_LIMITS.dormantTtlMs]
    )
    seeded.arm()

    await expect(store.assign(identity)).resolves.toMatchObject({
      cellId: 'cell-a',
      assignmentEpoch: 1
    })
    expect(
      await delegate.query(
        `SELECT reserved_controls FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ reserved_controls: 2 }])
    expect(await cellReservations(delegate)).toEqual({ 'cell-a': 2, 'cell-b': 0 })
    expect(
      await delegate.query(
        `SELECT lease_expires_at, last_activity_at FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([
      { lease_expires_at: now + ASSIGNMENT_LIMITS.activityLeaseMs, last_activity_at: now }
    ])
  })

  it('reserves control on the pinned cell when the only lease sits on another', async () => {
    const now = 100
    const store = await setup(() => now)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await database!.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, 'cell-b', 2, ?, ?, 1, 0, 0, 0, 0, 0)`,
      [
        identity.userId,
        identity.relayHostId,
        now + ASSIGNMENT_LIMITS.activityLeaseMs,
        now
      ]
    )
    await database!.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, 'control:cell-a:1', 'control', 'cell-a', 1, ?, ?)`,
      [
        identity.userId,
        identity.relayHostId,
        now + ASSIGNMENT_LIMITS.activityLeaseMs,
        now
      ]
    )
    await database!.query(
      `UPDATE relay_cells SET reserved_requests = 1 WHERE cell_id = 'cell-a'`
    )

    await expect(store.assign(identity)).resolves.toMatchObject({
      cellId: 'cell-b',
      assignmentEpoch: 2
    })
    expect(
      await database!.query(
        `SELECT activity_id, cell_id FROM relay_assignment_activity_leases
         ORDER BY activity_id ASC`
      )
    ).toEqual([
      { activity_id: 'control-pending:2', cell_id: 'cell-b' },
      { activity_id: 'control:cell-a:1', cell_id: 'cell-a' }
    ])
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 1, 'cell-b': 1 })
    expect(
      await database!.query(
        `SELECT reserved_controls FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ reserved_controls: 2 }])
  })

  it('mints a pending control when the only lease is an older epoch pending', async () => {
    const now = 100
    const store = await setup(() => now)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await database!.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, 'cell-a', 3, ?, ?, 1, 0, 0, 0, 0, 0)`,
      [
        identity.userId,
        identity.relayHostId,
        now + ASSIGNMENT_LIMITS.activityLeaseMs,
        now
      ]
    )
    await database!.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, 'control-pending:1', 'control', 'cell-a', 1, ?, ?)`,
      [
        identity.userId,
        identity.relayHostId,
        now + ASSIGNMENT_LIMITS.activityLeaseMs,
        now
      ]
    )
    await database!.query(
      `UPDATE relay_cells SET reserved_requests = 1 WHERE cell_id = 'cell-a'`
    )

    await expect(store.assign(identity)).resolves.toMatchObject({
      cellId: 'cell-a',
      assignmentEpoch: 3
    })
    expect(
      await database!.query(
        `SELECT activity_id FROM relay_assignment_activity_leases
         ORDER BY activity_id ASC`
      )
    ).toEqual([{ activity_id: 'control-pending:1' }, { activity_id: 'control-pending:3' }])
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 2, 'cell-b': 0 })
    expect(
      await database!.query(
        `SELECT reserved_controls FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ reserved_controls: 2 }])
  })

  it('re-reserves a re-pinned grant for a host holding no control lease', async () => {
    const now = 100
    const delegate = await openInMemoryRelayDatabase()
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const seeded = new SeedBetweenAssignmentLanesDatabase(delegate, async () => {
      await delegate.query(
        `INSERT INTO relay_assignment_activity_leases
         (user_id, relay_host_id, activity_id, activity_kind, cell_id,
          request_units, expires_at, updated_at)
         VALUES (?, ?, 'splice:connection-1', 'splice', 'cell-a', 1, ?, ?)`,
        [
          identity.userId,
          identity.relayHostId,
          now + ASSIGNMENT_LIMITS.activityLeaseMs,
          now
        ]
      )
      await delegate.query(
        `UPDATE relay_assignments SET reserved_splices = 1
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
      await delegate.query(
        `UPDATE relay_cells SET reserved_requests = 1 WHERE cell_id = 'cell-a'`
      )
    })
    database = seeded
    const store = new RelayAssignmentStore(seeded, () => now)
    await store.reconcileCells(CELLS)
    await delegate.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, 'cell-a', 1, ?, ?, 0, 0, 0, 0, 0, 0)`,
      [identity.userId, identity.relayHostId, now, now - ASSIGNMENT_LIMITS.dormantTtlMs]
    )
    seeded.arm()

    await expect(store.assign(identity)).resolves.toMatchObject({
      cellId: 'cell-a',
      assignmentEpoch: 1
    })
    expect(
      await delegate.query(
        `SELECT reserved_controls, reserved_splices FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ reserved_controls: 1, reserved_splices: 1 }])
    expect(
      await delegate.query(
        `SELECT activity_id FROM relay_assignment_activity_leases
         ORDER BY activity_id ASC`
      )
    ).toEqual([{ activity_id: 'control-pending:1' }, { activity_id: 'splice:connection-1' }])
    expect(await cellReservations(delegate)).toEqual({ 'cell-a': 2, 'cell-b': 0 })
  })

  it('extends the lease of a control-holding host on a sticky grant', async () => {
    let now = 100
    const store = await setup(() => now)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const assignment = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: assignment.cellId,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })

    now = 40_000
    await expect(store.assign(identity)).resolves.toMatchObject({
      cellId: assignment.cellId
    })
    expect(
      await database!.query(
        `SELECT lease_expires_at, last_activity_at FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([
      { lease_expires_at: now + ASSIGNMENT_LIMITS.activityLeaseMs, last_activity_at: now }
    ])
  })

  // The old absolute write shortened a 15-minute migration lease to the 90s
  // grant lease; only the touch's monotonic CASE keeps the longer one now.
  it('never shortens a migration lease to the grant lease', async () => {
    let now = 100
    const store = await setup(() => now)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const assignment = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: assignment.cellId,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    const before = await database!.query(
      `SELECT lease_expires_at FROM relay_assignments
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    expect(before).toEqual([{ lease_expires_at: 100 + ASSIGNMENT_LIMITS.migrationLeaseMs }])

    now = 1000
    await expect(store.assign(identity)).resolves.toMatchObject({ cellId: 'cell-b' })
    expect(
      await database!.query(
        `SELECT lease_expires_at, last_activity_at FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([
      { lease_expires_at: 100 + ASSIGNMENT_LIMITS.migrationLeaseMs, last_activity_at: now }
    ])
  })

  it('moves an origin-scoped activity reservation without double counting', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.assign(identity)
    await store.acquireActivity(identity, {
      activityId: 'splice:connection-1',
      kind: 'splice',
      cellId: 'cell-a'
    })
    await store.startEvacuation(identity, 'cell-b')
    await store.acquireActivity(identity, {
      activityId: 'splice:connection-1',
      kind: 'splice',
      cellId: 'cell-b'
    })

    expect(await cellReservations(database!)).toEqual({ 'cell-a': 1, 'cell-b': 6 })
    await expect(store.releaseActivity(identity, 'splice:connection-1')).resolves.toBe(true)
    await expect(store.releaseActivity(identity, 'splice:connection-1')).resolves.toBe(false)
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 1, 'cell-b': 4 })
  })

  it('rejects a durable activity before it can exceed cell capacity', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 2 }
    ])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.assign(identity)

    await expect(
      store.acquireActivity(identity, {
        activityId: 'splice:connection-1',
        kind: 'splice',
        cellId: 'cell-a'
      })
    ).rejects.toThrow('relay_capacity_exhausted')
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 1 })
  })

  it('moves active assignments target-first and completes only after source drain', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })

    const migration = await store.startEvacuation(identity, 'cell-b')
    expect(await store.startEvacuation(identity, 'cell-b')).toEqual(migration)
    expect(migration).toMatchObject({
      sourceCellId: 'cell-a',
      targetCellId: 'cell-b',
      previousEpoch: 1,
      assignmentEpoch: 2
    })
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 1, 'cell-b': 2 })

    const targetControl = await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: 2,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, { cellId: 'cell-b', assignmentEpoch: 2 })
    await expect(store.completeEvacuation(identity, 2)).rejects.toThrow(
      'migration_source_still_active'
    )
    await store.releaseActivity(identity, sourceControl)
    await store.completeEvacuation(identity, 2)

    expect(await cellReservations(database!)).toEqual({ 'cell-a': 0, 'cell-b': 1 })
    expect(await store.resolve(identity)).toMatchObject({ cellId: 'cell-b', assignmentEpoch: 2 })
    expect(
      await database!.query(
        `SELECT activity_id FROM relay_assignment_activity_leases ORDER BY activity_id`
      )
    ).toEqual([{ activity_id: targetControl }])
    await expect(
      store.acquireActivity(identity, {
        activityId: 'splice:late-source',
        kind: 'splice',
        cellId: 'cell-a'
      })
    ).rejects.toThrow('activity_cell_not_authoritative')
  })

  it('automatically completes only after the source runtime is freshly quiescent', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const store = await setupWithHeartbeats(() => now, cells)
    await heartbeat(store, cells[0]!)
    await heartbeat(store, cells[1]!)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.releaseActivity(identity, sourceControl)
    await store.setCellEnabled('cell-a', false)
    await heartbeat(store, cells[0]!, { observedRequests: 1 })

    expect(await store.completeReadyEvacuations()).toBe(0)
    await heartbeat(store, cells[0]!, { observedRequests: 0 })
    now = 150
    await heartbeat(store, cells[1]!, {
      incarnation: '22222222-2222-4222-8222-222222222222',
      startedAt: 125
    })
    expect(await store.completeReadyEvacuations()).toBe(0)
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 2
    })
    expect(await store.completeReadyEvacuations()).toBe(1)
  })

  it('completes a fenced migration only after the source heartbeat is stale', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const store = await setupWithHeartbeats(() => now, cells)
    await heartbeat(store, cells[0]!, { observedRequests: 1 })
    await heartbeat(store, cells[1]!)
    await store.setCellEnabled('cell-b', false)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.setCellEnabled('cell-b', true)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.releaseActivity(identity, sourceControl)
    await store.setCellEnabled('cell-a', false)

    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', true)).toMatchObject({
      inProgress: 1,
      blocked: 1
    })
    now += 45_001
    await heartbeat(store, cells[1]!)
    await store.attestCellFence(
      'cell-a',
      '11111111-1111-4111-8111-111111111111'
    )
    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', true)).toMatchObject({
      inProgress: 0,
      completed: 1
    })
  })

  it('blocks aggregate fenced completion on assignment accounting mismatch', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const store = await setupWithHeartbeats(() => now, cells)
    await heartbeat(store, cells[0]!)
    await heartbeat(store, cells[1]!)
    await store.setCellEnabled('cell-b', false)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.setCellEnabled('cell-b', true)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.releaseActivity(identity, sourceControl)
    await store.setCellEnabled('cell-a', false)
    await database!.query(
      `UPDATE relay_assignments SET reserved_splices = reserved_splices + 1
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    now += 45_001
    await heartbeat(store, cells[1]!)
    await store.attestCellFence(
      'cell-a',
      '11111111-1111-4111-8111-111111111111'
    )

    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', true)).toMatchObject({
      inProgress: 1,
      blocked: 1
    })
  })

  it('blocks aggregate fenced completion on an unexpected third-cell lease', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 },
      { id: 'cell-c', url: 'https://relay-c.example.com', capacityRequests: 10 }
    ]
    const store = await setupWithHeartbeats(() => now, cells)
    for (const cell of cells) await heartbeat(store, cell)
    await store.setCellEnabled('cell-b', false)
    await store.setCellEnabled('cell-c', false)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.setCellEnabled('cell-b', true)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.releaseActivity(identity, sourceControl)
    await store.setCellEnabled('cell-a', false)
    await database!.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity.userId,
        identity.relayHostId,
        'splice:unexpected-cell',
        'splice',
        'cell-c',
        2,
        now + ASSIGNMENT_LIMITS.activityLeaseMs,
        now
      ]
    )
    await database!.query(
      `UPDATE relay_assignments SET reserved_splices = reserved_splices + 1
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    await database!.query(
      `UPDATE relay_cells SET reserved_requests = reserved_requests + 2 WHERE cell_id = ?`,
      ['cell-c']
    )
    now += 45_001
    await heartbeat(store, cells[1]!)
    await store.attestCellFence(
      'cell-a',
      '11111111-1111-4111-8111-111111111111'
    )

    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', true)).toMatchObject({
      inProgress: 1,
      blocked: 1
    })
  })

  it('rolls back an unregistered expired evacuation with a strictly newer epoch', async () => {
    let now = 100
    const store = await setup(() => now, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.startEvacuation(identity, 'cell-b')

    now += ASSIGNMENT_LIMITS.migrationLeaseMs + 1
    expect(await store.abortExpiredEvacuations()).toBe(1)
    expect(await store.resolve(identity)).toMatchObject({ cellId: 'cell-a', assignmentEpoch: 3 })
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 1, 'cell-b': 0 })
  })

  // Why: completion needs an enabled target and expiry rollback needs an unregistered one, so a
  // target disabled after it registered satisfies neither and the migration never leaves the table.
  async function wedgeRegisteredMigration(
    now: () => number,
    cells: RelayCellConfig[],
    disableTarget = true,
    disableSource = true,
    releaseSourceControl = true
  ): Promise<{
    store: RelayAssignmentStore
    identity: { userId: string; relayHostId: string }
  }> {
    const store = await setupWithHeartbeats(now, cells)
    await heartbeat(store, cells[0]!)
    await heartbeat(store, cells[1]!)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    const migration = await store.startEvacuation(identity, 'cell-b')
    const targetControl = await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    if (releaseSourceControl) await store.releaseActivity(identity, sourceControl)
    if (disableSource) await store.setCellEnabled('cell-a', false)
    // The desktop leaves the half-migrated target, then an operator disables that cell.
    await store.releaseActivity(identity, targetControl)
    if (disableTarget) await store.setCellEnabled('cell-b', false)
    return { store, identity }
  }

  async function insertReservedControlConnection(
    identity: { userId: string; relayHostId: string },
    cellId: string,
    assignmentEpoch: number,
    now: number
  ): Promise<void> {
    await database!.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id, assignment_epoch,
        cell_id, state, created_at, timeout_at, updated_at)
       VALUES ('abandoned-reservation', 'abandoned-key', ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
      [identity.userId, identity.relayHostId, assignmentEpoch, cellId, now, now + 60_000, now]
    )
  }

  it('reaps an expired migration whose registered target cell was disabled', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const { store, identity } = await wedgeRegisteredMigration(() => now, cells)

    now += ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1
    // A disabled target can never satisfy completion, so waiting cannot help.
    expect(await store.completeReadyEvacuations()).toBe(0)
    expect(await store.abortExpiredEvacuations()).toBe(1)
    // Rollback lands on the disabled source, so the host resolves to nothing and is placed afresh
    // by evacuateDeadCells; the point is that the row is retired rather than reaped every tick.
    expect(await store.resolve(identity)).toBeNull()
    expect(await store.abortExpiredEvacuations()).toBe(0)
  })

  it('leaves a freshly disabled target for supersede-target to recover', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const { store } = await wedgeRegisteredMigration(() => now, cells)

    // Expired, but a disabled target is what supersede-target itself creates, so the operator
    // window must stay open; aborting here would fail their run with migration_already_superseded.
    now += ASSIGNMENT_LIMITS.migrationLeaseMs + 1
    expect(await store.abortExpiredEvacuations()).toBe(0)

    now += STRANDED_MIGRATION_ABANDON_MS
    expect(await store.abortExpiredEvacuations()).toBe(1)
  })

  it('rolls an abandoned disabled target back while its source remains active', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const { store, identity } = await wedgeRegisteredMigration(
      () => now,
      cells,
      true,
      false,
      false
    )

    now += ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1
    expect(await store.abortExpiredEvacuations()).toBe(1)
    expect(
      await database!.query(
        `SELECT cell_id, assignment_epoch FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ cell_id: 'cell-a', assignment_epoch: 3 }])
    expect(
      await database!.query(
        `SELECT completed_at, aborted_at FROM relay_assignment_migrations
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ completed_at: null, aborted_at: now }])
  })

  it('starts the abandon window when an old migration target is disabled', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const { store } = await wedgeRegisteredMigration(() => now, cells, false, false)
    now += ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1

    await store.setCellEnabled('cell-b', false)
    expect(await store.abortExpiredEvacuations()).toBe(0)

    now += STRANDED_MIGRATION_ABANDON_MS + 1
    expect(await store.abortExpiredEvacuations()).toBe(1)
  })

  it('reaps an expired migration from a retired source when its target control is gone', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const { store, identity } = await wedgeRegisteredMigration(() => now, cells, false)
    await applyGenerationZeroSelector(store, {
      attemptId: 'retired_source_migration_target',
      membership: {
        existingOnly: ['cell-a'],
        migrationOnly: ['cell-b'],
        general: []
      }
    })
    await insertReservedControlConnection(identity, 'cell-b', 2, now)

    now += ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1
    expect(await store.abortExpiredEvacuations()).toBe(1)
    expect(
      await database!.query(
        `SELECT assignment.cell_id, assignment.assignment_epoch,
           migration.completed_at, migration.aborted_at
         FROM relay_assignments assignment
         JOIN relay_assignment_migrations migration
           ON migration.user_id = assignment.user_id
          AND migration.relay_host_id = assignment.relay_host_id
         WHERE assignment.user_id = ? AND assignment.relay_host_id = ?
           AND migration.assignment_epoch = ?`,
        [identity.userId, identity.relayHostId, 2]
      )
    ).toEqual([
      {
        cell_id: 'cell-b',
        assignment_epoch: 2,
        completed_at: now,
        aborted_at: null
      }
    ])
    expect(
      await database!.query(
        `SELECT reserved_controls, migration_leases FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ reserved_controls: 0, migration_leases: 0 }])
    expect(
      await database!.query(
        `SELECT activity_id FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([])
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 0, 'cell-b': 0 })
    expect(
      await database!.query(
        `SELECT state FROM relay_control_connection_reservations
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ state: 'released' }])
  })

  it('reaps a retired-side migration with only a pending target control', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const store = await setupWithHeartbeats(() => now, cells)
    await heartbeat(store, cells[0]!)
    await heartbeat(store, cells[1]!)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.releaseActivity(identity, sourceControl)
    await applyGenerationZeroSelector(store, {
      attemptId: 'retired_source_pending_target',
      membership: {
        existingOnly: ['cell-a'],
        migrationOnly: ['cell-b'],
        general: []
      }
    })
    await insertReservedControlConnection(identity, 'cell-b', migration.assignmentEpoch, now)

    now += ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1
    await database!.query(
      `UPDATE relay_assignment_activity_leases SET expires_at = ?
       WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
      [now, identity.userId, identity.relayHostId, `control-pending:${migration.assignmentEpoch}`]
    )
    expect(await store.abortExpiredEvacuations()).toBe(1)
    expect(
      await database!.query(
        `SELECT cell_id, assignment_epoch FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ cell_id: 'cell-b', assignment_epoch: migration.assignmentEpoch }])
    expect(
      await database!.query(
        `SELECT reserved_controls, migration_leases FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ reserved_controls: 0, migration_leases: 0 }])
    expect(
      await database!.query(
        `SELECT activity_id FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([])
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 0, 'cell-b': 0 })
    expect(
      await database!.query(
        `SELECT state FROM relay_control_connection_reservations
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ state: 'released' }])
  })

  it('preserves a fresh target grant created after abandoned migration selection', async () => {
    let now = 100
    const cells: RelayCellConfig[] = [
      {
        id: 'cell-a',
        url: 'https://relay-a.example.com',
        capacityRequests: 10,
        connectionHardCap: 600,
        connectionUnobservedBound: 50
      },
      {
        id: 'cell-b',
        url: 'https://relay-b.example.com',
        capacityRequests: 10,
        connectionHardCap: 600,
        connectionUnobservedBound: 50
      }
    ]
    const { store, identity } = await wedgeRegisteredMigration(() => now, cells, false)
    await applyGenerationZeroSelector(store, {
      attemptId: 'retired_source_fresh_target_grant',
      membership: {
        existingOnly: ['cell-a'],
        migrationOnly: ['cell-b'],
        general: []
      }
    })

    now += 45_001
    await heartbeat(store, cells[1]!)
    await store.adoptLegacyCellFence(
      'cell-a',
      '11111111-1111-4111-8111-111111111111'
    )
    await store.commitLegacyCellFenceAdoption(
      'cell-a',
      '11111111-1111-4111-8111-111111111111'
    )
    now += ASSIGNMENT_LIMITS.migrationLeaseMs + 1
    await heartbeat(store, cells[1]!)
    const query = database!.query.bind(database)
    let grant: Awaited<ReturnType<typeof store.assign>> | undefined
    vi.spyOn(database!, 'query').mockImplementationOnce(async (sql, params) => {
      const rows = await query(sql, params)
      grant = await store.assign(identity)
      return rows
    })

    expect(await store.abortExpiredEvacuations()).toBe(0)
    expect(grant).toMatchObject({ cellId: 'cell-b', assignmentEpoch: 2 })
    expect(
      await database!.query(
        `SELECT activity_id, expires_at FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
        [identity.userId, identity.relayHostId, 'control-pending:2']
      )
    ).toEqual([{ activity_id: 'control-pending:2', expires_at: grant!.leaseExpiresAt }])
    expect(
      await database!.query(
        `SELECT state FROM relay_control_connection_reservations
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?
           AND cell_id = ? AND state = 'reserved'`,
        [identity.userId, identity.relayHostId, 2, 'cell-b']
      )
    ).toEqual([{ state: 'reserved' }])

    await store.activateControl(identity, {
      cellId: grant!.cellId,
      assignmentEpoch: grant!.assignmentEpoch,
      generation: 2
    })
    expect(
      await database!.query(
        `SELECT activity_id FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ? AND activity_kind = 'control'`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ activity_id: 'control:cell-b:2' }])
    expect(
      await database!.query(
        `SELECT completed_at FROM relay_assignment_migrations
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
        [identity.userId, identity.relayHostId, 2]
      )
    ).toEqual([{ completed_at: null }])
  })

  it('keeps an abandoned target migration open while its source is still active', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const { store, identity } = await wedgeRegisteredMigration(
      () => now,
      cells,
      false,
      true,
      false
    )
    await applyGenerationZeroSelector(store, {
      attemptId: 'retired_source_active',
      membership: {
        existingOnly: ['cell-a'],
        migrationOnly: ['cell-b'],
        general: []
      }
    })

    now += ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1
    expect(await store.abortExpiredEvacuations()).toBe(0)
    expect(
      await database!.query(
        `SELECT completed_at, aborted_at FROM relay_assignment_migrations
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ completed_at: null, aborted_at: null }])
  })

  it('starts the abandon window when an old migration source is retired', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const { store } = await wedgeRegisteredMigration(() => now, cells, false, false)
    now += ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1

    await store.setCellEnabled('cell-a', false)
    expect(await store.abortExpiredEvacuations()).toBe(0)

    now += STRANDED_MIGRATION_ABANDON_MS + 1
    expect(await store.abortExpiredEvacuations()).toBe(1)
  })

  it('reaps after an old source migration lease is refreshed and expires', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const { store } = await wedgeRegisteredMigration(() => now, cells, false)
    await applyGenerationZeroSelector(store, {
      attemptId: 'retired_source_refreshed_lease',
      membership: {
        existingOnly: ['cell-a'],
        migrationOnly: ['cell-b'],
        general: []
      }
    })
    now += STRANDED_MIGRATION_ABANDON_MS + ASSIGNMENT_LIMITS.migrationLeaseMs + 1
    await database!.query(
      `UPDATE relay_assignment_migrations SET expires_at = ?`,
      [now - 1]
    )

    expect(await store.abortExpiredEvacuations()).toBe(1)
  })

  it('keeps a freshly retired target open despite an old retired source', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const { store } = await wedgeRegisteredMigration(() => now, cells, false)
    now += ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1

    await store.setCellEnabled('cell-b', false)
    expect(await store.abortExpiredEvacuations()).toBe(0)

    now += STRANDED_MIGRATION_ABANDON_MS + 1
    expect(await store.abortExpiredEvacuations()).toBe(1)
  })

  it('fails supersession closed when reaping wins after selection', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 },
      { id: 'cell-c', url: 'https://relay-c.example.com', capacityRequests: 10 }
    ]
    const { store } = await wedgeRegisteredMigration(() => now, cells)
    now += ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1
    const query = database!.query.bind(database)
    vi.spyOn(database!, 'query').mockImplementationOnce(async (sql, params) => {
      const rows = await query(sql, params)
      expect(await store.abortExpiredEvacuations()).toBe(1)
      return rows
    })

    await expect(
      store.supersedeRegisteredCellEvacuations('cell-a', 'cell-b', 'cell-c', 100)
    ).rejects.toThrow('migration_already_superseded')
  })

  it('fails supersession closed when reaping wins after preparation', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 },
      { id: 'cell-c', url: 'https://relay-c.example.com', capacityRequests: 10 }
    ]
    const { store } = await wedgeRegisteredMigration(() => now, cells)
    now += ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1
    await store.attestCellFence('cell-b', '11111111-1111-4111-8111-111111111111')
    const supersede = store.supersedeRegisteredEvacuation.bind(store)
    vi.spyOn(store, 'supersedeRegisteredEvacuation').mockImplementationOnce(async (...args) => {
      expect(await store.abortExpiredEvacuations()).toBe(1)
      return await supersede(...args)
    })

    await expect(
      store.supersedeRegisteredCellEvacuations('cell-a', 'cell-b', 'cell-c', 100)
    ).rejects.toThrow('migration_already_superseded')
  })

  it('fails supersession closed when reaping wins before an accounting retry', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 },
      { id: 'cell-c', url: 'https://relay-c.example.com', capacityRequests: 10 }
    ]
    const { store } = await wedgeRegisteredMigration(() => now, cells)
    now += ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1
    await heartbeat(store, cells[0]!)
    await heartbeat(store, cells[2]!)
    await store.attestCellFence('cell-b', '11111111-1111-4111-8111-111111111111')
    await database!.query(`UPDATE relay_cells SET reserved_requests = 1 WHERE cell_id = ?`, [
      'cell-c'
    ])
    const supersede = store.supersedeRegisteredEvacuation.bind(store)
    let attempts = 0
    vi.spyOn(store, 'supersedeRegisteredEvacuation').mockImplementation(async (...args) => {
      attempts++
      if (attempts === 2) expect(await store.abortExpiredEvacuations()).toBe(1)
      return await supersede(...args)
    })

    await expect(
      store.supersedeRegisteredCellEvacuations('cell-a', 'cell-b', 'cell-c', 100)
    ).rejects.toThrow('migration_already_superseded')
    expect(attempts).toBe(2)
  })

  it('reaps a pinned expired migration once its target cell is disabled', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ]
    const { store, identity } = await wedgeRegisteredMigration(() => now, cells)
    // Drains pin their migrations and nothing ever deletes a pin, so the pin outlives the drain.
    await database!.query(
      `INSERT INTO relay_post_drain_migration_pins
       (user_id, relay_host_id, assignment_epoch, drain_attempt_id, source_cell_id,
        source_cell_incarnation, target_cell_id, target_cell_incarnation,
        source_request_units, target_reserved_units, pinned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity.userId,
        identity.relayHostId,
        2,
        'attempt-0000',
        'cell-a',
        '11111111-1111-4111-8111-111111111111',
        'cell-b',
        '11111111-1111-4111-8111-111111111111',
        1,
        1,
        now
      ]
    )

    now += ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1
    expect(await store.completeReadyEvacuations()).toBe(0)
    expect(await store.abortExpiredEvacuations()).toBe(1)
    expect(await store.abortExpiredEvacuations()).toBe(0)
  })

  it('repairs an expired migration marker from its exact active target control', async () => {
    let now = 100
    const store = await setup(() => now, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: 2,
      generation: 1
    })

    now += ASSIGNMENT_LIMITS.migrationLeaseMs + 1
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: 2,
      generation: 1
    })
    expect(await store.abortExpiredEvacuations()).toBe(0)
    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', false)).toEqual({
      inProgress: 1,
      oldestExpiresAt: 100 + ASSIGNMENT_LIMITS.migrationLeaseMs,
      oldestRemainingMs: -1,
      targetRegistered: 1,
      registeredSourceActive: 1,
      registeredCompletable: 0,
      registeredTargetInactive: 0,
      completed: 0,
      blocked: 0,
      ...NO_EXPIRED_EVACUATION_DIAGNOSTICS
    })
    await store.releaseActivity(identity, sourceControl)
    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', true)).toEqual({
      inProgress: 0,
      ...NO_ACTIVE_MIGRATION_LEASE,
      targetRegistered: 0,
      ...NO_REGISTERED_EVACUATION_DIAGNOSTICS,
      completed: 1,
      blocked: 0,
      ...NO_EXPIRED_EVACUATION_DIAGNOSTICS
    })
    expect(await store.resolve(identity)).toMatchObject({ cellId: 'cell-b', assignmentEpoch: 2 })
  })

  it('keeps a registered migration pending while its proven target control is offline', async () => {
    let now = 100
    const store = await setup(() => now, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    const migration = await store.startEvacuation(identity, 'cell-b')
    const targetControl = await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 2
    })
    expect(
      await store.markMigrationTargetRegistered(identity, {
        cellId: 'cell-b',
        assignmentEpoch: migration.assignmentEpoch
      })
    ).toBe(true)
    expect(await store.completeReadyEvacuations()).toBe(0)
    await store.releaseActivity(identity, sourceControl)
    now += ASSIGNMENT_LIMITS.activityLeaseMs + 1
    expect(await store.completeReadyEvacuations()).toBe(0)
    await expect(
      store.completeEvacuation(identity, migration.assignmentEpoch)
    ).rejects.toThrow('migration_target_not_active')
    await store.releaseActivity(identity, targetControl)
    expect(await store.completeReadyEvacuations()).toBe(0)

    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', true)).toEqual({
      inProgress: 1,
      oldestExpiresAt: 100 + ASSIGNMENT_LIMITS.migrationLeaseMs,
      oldestRemainingMs:
        ASSIGNMENT_LIMITS.migrationLeaseMs - ASSIGNMENT_LIMITS.activityLeaseMs - 1,
      targetRegistered: 1,
      registeredSourceActive: 0,
      registeredCompletable: 0,
      registeredTargetInactive: 1,
      completed: 0,
      blocked: 1,
      ...NO_EXPIRED_EVACUATION_DIAGNOSTICS
    })

    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 3
    })
    expect(await store.completeReadyEvacuations()).toBe(1)
    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', false)).toEqual({
      inProgress: 0,
      ...NO_ACTIVE_MIGRATION_LEASE,
      targetRegistered: 0,
      ...NO_REGISTERED_EVACUATION_DIAGNOSTICS,
      completed: 0,
      blocked: 0,
      ...NO_EXPIRED_EVACUATION_DIAGNOSTICS
    })
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 0, 'cell-b': 1 })
  })

  it('completes a registered migration after its disabled source is proven dead', async () => {
    let now = 100
    const store = await setupWithHeartbeats(() => now, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ])
    await heartbeat(store, { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 })
    await heartbeat(store, { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 })
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.releaseActivity(identity, sourceControl)
    now += 45_001
    await heartbeat(
      store,
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 },
      { startedAt: 50 }
    )
    await store.attestCellFence(
      'cell-a',
      '11111111-1111-4111-8111-111111111111'
    )

    const input = {
      assignmentEpoch: migration.assignmentEpoch,
      sourceCellId: 'cell-a',
      targetCellId: 'cell-b'
    }
    await expect(store.completeEvacuationFromDeadSource(identity, input)).resolves.toEqual({
      changed: true,
      assignmentEpoch: 2,
      sourceCellId: 'cell-a',
      targetCellId: 'cell-b'
    })
    await expect(store.completeEvacuationFromDeadSource(identity, input)).resolves.toEqual({
      changed: false,
      assignmentEpoch: 2,
      sourceCellId: 'cell-a',
      targetCellId: 'cell-b'
    })
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 0, 'cell-b': 1 })
    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', false)).toMatchObject({
      inProgress: 0
    })
  })

  it('retires an inactive registered migration after its source is proven dead', async () => {
    let now = 100
    const cells = [
      {
        id: 'cell-a',
        url: 'https://relay-a.example.com',
        capacityRequests: 10,
        connectionHardCap: 600 as const,
        connectionUnobservedBound: 50
      },
      {
        id: 'cell-b',
        url: 'https://relay-b.example.com',
        capacityRequests: 10,
        connectionHardCap: 600 as const,
        connectionUnobservedBound: 50
      }
    ]
    const store = await setupWithHeartbeats(() => now, cells)
    await heartbeat(store, cells[0]!)
    await heartbeat(store, cells[1]!)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.releaseActivity(identity, sourceControl)
    now += 45_001
    await heartbeat(store, cells[1]!, { startedAt: 50 })
    await store.attestCellFence('cell-a', '11111111-1111-4111-8111-111111111111')

    await expect(
      store.cellEvacuationStatus('cell-a', 'cell-b', true)
    ).resolves.toMatchObject({ inProgress: 0, completed: 1, blocked: 0 })
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 0, 'cell-b': 0 })
    expect(
      await database!.query(
        `SELECT activity_id FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([])
    expect(
      await database!.query(
        `SELECT state FROM relay_control_connection_reservations
         WHERE user_id = ? AND relay_host_id = ? AND cell_id = ? AND assignment_epoch = ?`,
        [identity.userId, identity.relayHostId, 'cell-b', migration.assignmentEpoch]
      )
    ).toEqual([{ state: 'released' }])
    expect(
      await database!.query(
        `SELECT cell_id, assignment_epoch, reserved_controls, migration_leases
         FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([
      {
        cell_id: 'cell-b',
        assignment_epoch: 2,
        reserved_controls: 0,
        migration_leases: 0
      }
    ])
  })

  it.each(['expired', 'previous-incarnation'] as const)(
    'retires a registered migration and its %s target control after the source dies',
    async (targetControlState) => {
      let now = 100
      const cells = [
        {
          id: 'cell-a',
          url: 'https://relay-a.example.com',
          capacityRequests: 10,
          connectionHardCap: 600 as const,
          connectionUnobservedBound: 50
        },
        {
          id: 'cell-b',
          url: 'https://relay-b.example.com',
          capacityRequests: 10,
          connectionHardCap: 600 as const,
          connectionUnobservedBound: 50
        }
      ]
      const store = await setupWithHeartbeats(() => now, cells)
      await heartbeat(store, cells[0]!)
      await heartbeat(store, cells[1]!)
      const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
      const first = await store.assign(identity)
      const sourceControl = await store.activateControl(identity, {
        cellId: first.cellId,
        assignmentEpoch: first.assignmentEpoch,
        generation: 1
      })
      await store.setCellEnabled('cell-a', false)
      const migration = await store.startEvacuation(identity, 'cell-b')
      await store.activateControl(identity, {
        cellId: 'cell-b',
        assignmentEpoch: migration.assignmentEpoch,
        generation: 1
      })
      await store.markMigrationTargetRegistered(identity, {
        cellId: 'cell-b',
        assignmentEpoch: migration.assignmentEpoch
      })
      await store.releaseActivity(identity, sourceControl)
      now +=
        targetControlState === 'expired'
          ? ASSIGNMENT_LIMITS.activityLeaseMs + 1
          : 45_001
      await heartbeat(store, cells[1]!, {
        startedAt: targetControlState === 'previous-incarnation' ? now - 1 : 50,
        incarnation:
          targetControlState === 'previous-incarnation'
            ? '22222222-2222-4222-8222-222222222222'
            : '11111111-1111-4111-8111-111111111111'
      })
      await store.attestCellFence(
        'cell-a',
        '11111111-1111-4111-8111-111111111111'
      )

      await expect(
        store.cellEvacuationStatus('cell-a', 'cell-b', false)
      ).resolves.toMatchObject({
        inProgress: 1,
        registeredCompletable: 0,
        registeredTargetInactive: 1
      })
      await expect(
        store.cellEvacuationStatus('cell-a', 'cell-b', true)
      ).resolves.toMatchObject({ inProgress: 0, completed: 1, blocked: 0 })
      expect(await cellReservations(database!)).toEqual({ 'cell-a': 0, 'cell-b': 0 })
      expect(
        await database!.query(
          `SELECT activity_id FROM relay_assignment_activity_leases
           WHERE user_id = ? AND relay_host_id = ?`,
          [identity.userId, identity.relayHostId]
        )
      ).toEqual([])
      expect(
        await database!.query(
          `SELECT cell_id, assignment_epoch, reserved_controls, migration_leases
           FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
          [identity.userId, identity.relayHostId]
        )
      ).toEqual([
        {
          cell_id: 'cell-b',
          assignment_epoch: migration.assignmentEpoch,
          reserved_controls: 0,
          migration_leases: 0
        }
      ])
    }
  )

  it('refuses dead-source completion while the source heartbeat is fresh', async () => {
    const store = await setupWithHeartbeats(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ])
    await heartbeat(store, { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 })
    await heartbeat(store, { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 })
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.releaseActivity(identity, sourceControl)

    await expect(
      store.attestCellFence('cell-a', '11111111-1111-4111-8111-111111111111')
    ).rejects.toThrow('cell_fence_runtime_not_stale')
    await expect(
      store.completeEvacuationFromDeadSource(identity, {
        assignmentEpoch: migration.assignmentEpoch,
        sourceCellId: 'cell-a',
        targetCellId: 'cell-b'
      })
    ).rejects.toThrow('cell_fence_attestation_missing')
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 0, 'cell-b': 2 })
  })

  it('supersedes a registered migration after its disabled target is proven unavailable', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 },
      { id: 'cell-c', url: 'https://relay-c.example.com', capacityRequests: 10 }
    ]
    const store = await setupWithHeartbeats(() => now, cells)
    for (const cell of cells) await heartbeat(store, cell)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await database!.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id,
        assignment_epoch, cell_id, state, inclusion_watermark,
        claim_activity_id, created_at, timeout_at, claimed_at, released_at,
        updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'late-arrival-debt', NULL, NULL, ?, ?, NULL, NULL, ?)`,
      [
        'superseded-reservation',
        'superseded-reservation',
        identity.userId,
        identity.relayHostId,
        migration.assignmentEpoch,
        'cell-b',
        100,
        100,
        100
      ]
    )
    await store.setCellEnabled('cell-b', false)
    now += 45_001
    await heartbeat(store, cells[0]!, { startedAt: 50 })
    await heartbeat(store, cells[2]!, { startedAt: 50 })
    await store.attestCellFence(
      'cell-b',
      '11111111-1111-4111-8111-111111111111'
    )
    const input = {
      assignmentEpoch: migration.assignmentEpoch,
      sourceCellId: 'cell-a',
      currentTargetCellId: 'cell-b',
      replacementTargetCellId: 'cell-c'
    }

    const replacement = await store.supersedeRegisteredEvacuation(identity, input)
    expect(replacement).toMatchObject({
      sourceCellId: 'cell-a',
      targetCellId: 'cell-c',
      previousEpoch: 2,
      assignmentEpoch: 3
    })
    await expect(store.supersedeRegisteredEvacuation(identity, input)).resolves.toEqual(replacement)
    expect(await store.resolve(identity)).toMatchObject({ cellId: 'cell-c', assignmentEpoch: 3 })
    expect(
      await database!.query(
        `SELECT state FROM relay_control_connection_reservations
         WHERE reservation_id = ?`,
        ['superseded-reservation']
      )
    ).toEqual([{ state: 'released' }])
    expect(await cellReservations(database!)).toEqual({
      'cell-a': 1,
      'cell-b': 0,
      'cell-c': 2
    })
    expect(
      await database!.query(
        `SELECT activity_kind, cell_id FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ? ORDER BY cell_id, activity_id`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([
      { activity_kind: 'control', cell_id: 'cell-a' },
      { activity_kind: 'control', cell_id: 'cell-c' },
      { activity_kind: 'migration', cell_id: 'cell-c' }
    ])
    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', false)).toMatchObject({
      inProgress: 0
    })
    expect(await store.cellEvacuationStatus('cell-a', 'cell-c', false)).toMatchObject({
      inProgress: 1
    })
  })

  it('retries registered migration supersession with inventory locked first', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 },
      { id: 'cell-c', url: 'https://relay-c.example.com', capacityRequests: 10 }
    ]
    const delegate = await openInMemoryRelayDatabase()
    const retryDatabase = new OneShotInventoryFailureDatabase(delegate)
    database = retryDatabase
    const store = new RelayAssignmentStore(retryDatabase, () => now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    await store.reconcileCells(cells)
    for (const cell of cells) await heartbeat(store, cell)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.setCellEnabled('cell-b', false)
    now += 45_001
    await heartbeat(store, cells[0]!, { startedAt: 50 })
    await heartbeat(store, cells[2]!, { startedAt: 50 })
    await store.attestCellFence(
      'cell-b',
      '11111111-1111-4111-8111-111111111111'
    )
    retryDatabase.arm()

    await expect(
      store.supersedeRegisteredEvacuation(identity, {
        assignmentEpoch: migration.assignmentEpoch,
        sourceCellId: 'cell-a',
        currentTargetCellId: 'cell-b',
        replacementTargetCellId: 'cell-c'
      })
    ).resolves.toMatchObject({ targetCellId: 'cell-c', assignmentEpoch: 3 })
    expect(retryDatabase.retryLocks).toEqual([
      'inventory-nowait-failed',
      'inventory-first',
      'assignment-nowait'
    ])
  })

  it('reconciles durable cell accounting once before aggregate supersession', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 },
      { id: 'cell-c', url: 'https://relay-c.example.com', capacityRequests: 10 }
    ]
    const store = await setupWithHeartbeats(() => now, cells)
    for (const cell of cells) await heartbeat(store, cell)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.setCellEnabled('cell-b', false)
    now += 45_001
    await heartbeat(store, cells[0]!, { startedAt: 50 })
    await heartbeat(store, cells[2]!, { startedAt: 50 })
    await store.attestCellFence(
      'cell-b',
      '11111111-1111-4111-8111-111111111111'
    )
    await database!.query(
      `UPDATE relay_cells
       SET reserved_requests = CASE WHEN cell_id = ? THEN 1 ELSE 0 END
       WHERE cell_id IN (?, ?)`,
      ['cell-c', 'cell-a', 'cell-c']
    )

    await expect(
      store.supersedeRegisteredCellEvacuations('cell-a', 'cell-b', 'cell-c', 100)
    ).resolves.toBe(1)
    expect(await cellReservations(database!)).toEqual({
      'cell-a': 1,
      'cell-b': 0,
      'cell-c': 2
    })
    expect(
      await database!.query(
        `SELECT assignment_epoch, target_cell_id, aborted_at
         FROM relay_assignment_migrations
         WHERE user_id = ? ORDER BY assignment_epoch`,
        [identity.userId]
      )
    ).toEqual([
      { assignment_epoch: 2, target_cell_id: 'cell-b', aborted_at: 45_101 },
      { assignment_epoch: 3, target_cell_id: 'cell-c', aborted_at: null }
    ])
  })

  it('preserves healthy third-cell activity during aggregate supersession', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 },
      { id: 'cell-c', url: 'https://relay-c.example.com', capacityRequests: 10 },
      { id: 'cell-d', url: 'https://relay-d.example.com', capacityRequests: 10 }
    ]
    const store = await setupWithHeartbeats(() => now, cells)
    for (const cell of cells) await heartbeat(store, cell)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await database!.query(
      `UPDATE relay_assignment_activity_leases SET cell_id = ?
       WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
      ['cell-d', identity.userId, identity.relayHostId, sourceControl]
    )
    await database!.query(
      `UPDATE relay_cells SET reserved_requests = ? WHERE cell_id = ?`,
      [5, 'cell-c']
    )
    await store.setCellEnabled('cell-b', false)
    now += 45_001
    await heartbeat(store, cells[0]!, { startedAt: 50 })
    await heartbeat(store, cells[2]!, { startedAt: 50 })
    await heartbeat(store, cells[3]!, { startedAt: 50 })
    await store.attestCellFence(
      'cell-b',
      '11111111-1111-4111-8111-111111111111'
    )

    await expect(
      store.supersedeRegisteredCellEvacuations('cell-a', 'cell-b', 'cell-c', 100)
    ).resolves.toBe(1)
    expect(await cellReservations(database!)).toEqual({
      'cell-a': 0,
      'cell-b': 0,
      'cell-c': 1,
      'cell-d': 1
    })
    expect(
      await database!.query(
        `SELECT activity_kind, cell_id FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ? ORDER BY cell_id, activity_id`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([
      { activity_kind: 'control', cell_id: 'cell-c' },
      { activity_kind: 'migration', cell_id: 'cell-c' },
      { activity_kind: 'control', cell_id: 'cell-d' }
    ])
  })

  it('refuses supersession while the registered target remains available', async () => {
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 },
      { id: 'cell-c', url: 'https://relay-c.example.com', capacityRequests: 10 }
    ]
    const store = await setupWithHeartbeats(() => 100, cells)
    for (const cell of cells) await heartbeat(store, cell)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.setCellEnabled('cell-b', false)

    await expect(
      store.attestCellFence('cell-b', '11111111-1111-4111-8111-111111111111')
    ).rejects.toThrow('cell_fence_runtime_not_stale')
    await expect(
      store.supersedeRegisteredEvacuation(identity, {
        assignmentEpoch: migration.assignmentEpoch,
        sourceCellId: 'cell-a',
        currentTargetCellId: 'cell-b',
        replacementTargetCellId: 'cell-c'
      })
    ).rejects.toThrow('cell_fence_attestation_missing')
    expect(
      await database!.query(
        `SELECT cell_id, assignment_epoch FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ cell_id: 'cell-b', assignment_epoch: 2 }])
  })

  it('serializes concurrent retries of registered migration supersession', async () => {
    let now = 100
    const cells = [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 },
      { id: 'cell-c', url: 'https://relay-c.example.com', capacityRequests: 10 }
    ]
    const store = await setupWithHeartbeats(() => now, cells)
    for (const cell of cells) await heartbeat(store, cell)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.setCellEnabled('cell-a', false)
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.setCellEnabled('cell-b', false)
    now += 45_001
    await heartbeat(store, cells[0]!, { startedAt: 50 })
    await heartbeat(store, cells[2]!, { startedAt: 50 })
    await store.attestCellFence(
      'cell-b',
      '11111111-1111-4111-8111-111111111111'
    )
    const input = {
      assignmentEpoch: migration.assignmentEpoch,
      sourceCellId: 'cell-a',
      currentTargetCellId: 'cell-b',
      replacementTargetCellId: 'cell-c'
    }

    const results = await Promise.all([
      store.supersedeRegisteredEvacuation(identity, input),
      store.supersedeRegisteredEvacuation(identity, input)
    ])
    expect(results[0]).toEqual(results[1])
    expect(
      await database!.query(
        `SELECT assignment_epoch FROM relay_assignment_migrations
         WHERE user_id = ? AND relay_host_id = ? ORDER BY assignment_epoch`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ assignment_epoch: 2 }, { assignment_epoch: 3 }])
    expect(await cellReservations(database!)).toEqual({
      'cell-a': 1,
      'cell-b': 0,
      'cell-c': 2
    })
  })

  it('classifies an expired migration blocked by a newer target assignment', async () => {
    let now = 100
    const store = await setup(() => now, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 20 }
    ])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: 2,
      generation: 1
    })
    await database!.query(
      `UPDATE relay_assignments SET assignment_epoch = ?
       WHERE user_id = ? AND relay_host_id = ?`,
      [3, identity.userId, identity.relayHostId]
    )

    now += ASSIGNMENT_LIMITS.migrationLeaseMs + 1
    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', false)).toEqual({
      inProgress: 1,
      oldestExpiresAt: 100 + ASSIGNMENT_LIMITS.migrationLeaseMs,
      oldestRemainingMs: -1,
      targetRegistered: 0,
      ...NO_REGISTERED_EVACUATION_DIAGNOSTICS,
      completed: 0,
      blocked: 0,
      expiredUnregistered: 1,
      repairableExpiredUnregistered: 0,
      abortableExpiredUnregistered: 0,
      blockedExpiredUnregistered: 1,
      blockedExpiredOnNewerTargetAssignment: 1
    })
  })

  it('does not complete a registered migration after the assignment epoch advances', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 20 }
    ])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.releaseActivity(identity, sourceControl)
    await database!.query(
      `UPDATE relay_assignments SET assignment_epoch = ?
       WHERE user_id = ? AND relay_host_id = ?`,
      [migration.assignmentEpoch + 1, identity.userId, identity.relayHostId]
    )

    expect(await store.completeReadyEvacuations()).toBe(0)
    await expect(
      store.completeEvacuation(identity, migration.assignmentEpoch)
    ).rejects.toThrow('migration_assignment_mismatch')
    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', false)).toMatchObject({
      inProgress: 1,
      targetRegistered: 1
    })
  })

  it('retires an expired migration without rewriting its newer target assignment', async () => {
    let now = 100
    const store = await setup(() => now, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 20 }
    ])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: 2,
      generation: 1
    })
    await database!.query(
      `UPDATE relay_assignments SET assignment_epoch = ?
       WHERE user_id = ? AND relay_host_id = ?`,
      [3, identity.userId, identity.relayHostId]
    )

    now += ASSIGNMENT_LIMITS.migrationLeaseMs + 1
    expect(await store.abortExpiredEvacuations()).toBe(1)
    expect(await store.resolve(identity)).toMatchObject({
      cellId: 'cell-b',
      assignmentEpoch: 3
    })
    expect(
      await database!.query(
        `SELECT activity_id FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ? ORDER BY activity_id`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([
      { activity_id: 'control:cell-a:1' },
      { activity_id: 'control:cell-b:1' }
    ])
    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', false)).toMatchObject({
      inProgress: 0
    })
  })

  it.each([
    { assignmentEpoch: 1, removeAssignment: false, expected: 'migration_assignment_mismatch' },
    { assignmentEpoch: 2, removeAssignment: true, expected: 'migration_assignment_missing' }
  ])(
    'fails closed when expired migration assignment state is not superseding: $expected',
    async ({ assignmentEpoch, removeAssignment, expected }) => {
      let now = 100
      const store = await setup(() => now, [
        { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 },
        { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 20 }
      ])
      const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
      await store.assign(identity)
      await store.startEvacuation(identity, 'cell-b')
      if (removeAssignment) {
        await database!.query(
          `DELETE FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
          [identity.userId, identity.relayHostId]
        )
      } else {
        await database!.query(
          `UPDATE relay_assignments SET assignment_epoch = ?
           WHERE user_id = ? AND relay_host_id = ?`,
          [assignmentEpoch, identity.userId, identity.relayHostId]
        )
      }

      now += ASSIGNMENT_LIMITS.migrationLeaseMs + 1
      await expect(store.abortExpiredEvacuations()).rejects.toThrow(expected)
      expect(await store.cellEvacuationStatus('cell-a', 'cell-b', false)).toMatchObject({
        inProgress: 1,
        targetRegistered: 0
      })
    }
  )

  it('reconciles duplicated assignment counters and cell reservations after evacuation', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 20 }
    ])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: 2,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: 2
    })
    await store.releaseActivity(identity, sourceControl)
    await database!.query(
      `UPDATE relay_assignments SET reserved_controls = 9, reserved_splices = 4,
       reserved_invites = 3, pending_installs = 2, pending_confirmations = 2,
       migration_leases = 7 WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    await database!.query(
      `UPDATE relay_cells SET reserved_requests =
       CASE WHEN cell_id = ? THEN 11 ELSE 3 END`,
      ['cell-a']
    )

    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', true)).toEqual({
      inProgress: 0,
      ...NO_ACTIVE_MIGRATION_LEASE,
      targetRegistered: 0,
      ...NO_REGISTERED_EVACUATION_DIAGNOSTICS,
      completed: 1,
      blocked: 0,
      ...NO_EXPIRED_EVACUATION_DIAGNOSTICS
    })
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 0, 'cell-b': 1 })
    expect(
      await database!.query(
        `SELECT reserved_controls, reserved_splices, reserved_invites,
           pending_installs, pending_confirmations, migration_leases
         FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([
      {
        reserved_controls: 1,
        reserved_splices: 0,
        reserved_invites: 0,
        pending_installs: 0,
        pending_confirmations: 0,
        migration_leases: 0
      }
    ])
  })

  it('refuses reservation reconciliation when an activity lease has no assignment', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 20 }
    ])
    await database!.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['orphan-user', 'orphanhost000001', 'control:orphan', 'control', 'cell-a', 1, 200, 100]
    )

    await expect(store.cellEvacuationStatus('cell-a', 'cell-b', true)).rejects.toThrow(
      'activity_lease_assignment_missing'
    )
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 0, 'cell-b': 0 })
  })

  it('refuses reservation reconciliation when an activity lease names no cell', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 20 }
    ])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.assign(identity)
    await database!.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity.userId,
        identity.relayHostId,
        'splice:missing-cell',
        'splice',
        'missing-cell',
        2,
        200,
        100
      ]
    )

    await expect(store.cellEvacuationStatus('cell-a', 'cell-b', true)).rejects.toThrow(
      'activity_lease_cell_missing'
    )
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 1, 'cell-b': 0 })
  })

  it('leaves accounting for cells outside the selected evacuation pair unchanged', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 20 },
      { id: 'cell-c', url: 'https://relay-c.example.com', capacityRequests: 20 }
    ])
    await database!.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['unrelated-user', 'unrelatedhost001', 'cell-c', 1, 200, 100, 9, 0, 0, 0, 0, 0]
    )
    await database!.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'unrelated-user',
        'unrelatedhost001',
        'control:unrelated',
        'control',
        'cell-c',
        1,
        200,
        100
      ]
    )
    await database!.query(
      `UPDATE relay_cells SET reserved_requests = 9 WHERE cell_id = ?`,
      ['cell-c']
    )

    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', true)).toMatchObject({
      inProgress: 0
    })
    expect(await cellReservations(database!)).toEqual({
      'cell-a': 0,
      'cell-b': 0,
      'cell-c': 9
    })
    expect(
      await database!.query(
        `SELECT reserved_controls FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        ['unrelated-user', 'unrelatedhost001']
      )
    ).toEqual([{ reserved_controls: 9 }])
  })

  it('rebalances only a fully inactive assignment after the dormant TTL', async () => {
    let now = 100
    const store = await setup(() => now, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const control = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await expect(store.rebalanceDormant(identity, 'cell-b')).rejects.toThrow('assignment_active')
    await store.releaseActivity(identity, control)
    now += ASSIGNMENT_LIMITS.dormantTtlMs + 1

    await expect(store.rebalanceDormant(identity, 'cell-b')).resolves.toMatchObject({
      cellId: 'cell-b',
      assignmentEpoch: 2
    })
    expect(await cellReservations(database!)).toEqual({ 'cell-a': 0, 'cell-b': 1 })
  })

  it('durably removes an unhealthy cell from new assignment without moving existing hosts', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ])
    const existing = { userId: 'user-a', relayHostId: 'host000000000001' }
    expect(await store.assign(existing)).toMatchObject({ cellId: 'cell-a' })
    await store.setCellEnabled('cell-a', false)
    await store.reconcileCells([
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
    ])
    expect(await store.resolve(existing)).toMatchObject({ cellId: 'cell-a' })
    await expect(
      store.assign({ userId: 'user-b', relayHostId: 'host000000000002' })
    ).resolves.toMatchObject({ cellId: 'cell-b' })
    await store.setCellEnabled('cell-a', true)
    await expect(store.setCellEnabled('missing', false)).rejects.toThrow('cell_not_found')
  })

  it('bulk-migrates active controls without exposing assignment identities', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 20 }
    ])
    await store.setCellEnabled('cell-b', false)
    const identities = [1, 2, 3].map((index) => ({
      userId: `user-${index}`,
      relayHostId: `host${String(index).padStart(12, '0')}`
    }))
    const sourceControls: string[] = []
    for (const identity of identities) {
      const assignment = await store.assign(identity)
      sourceControls.push(
        await store.activateControl(identity, {
          cellId: 'cell-a',
          assignmentEpoch: assignment.assignmentEpoch,
          generation: 1
        })
      )
    }
    await store.setCellEnabled('cell-b', true)
    expect(await store.cellEvacuationCapacity('cell-a', 'cell-b')).toEqual({
      sourceAssignments: 3,
      requiredTargetUnits: 6,
      availableTargetUnits: 20
    })
    expect(await store.startActiveCellEvacuations('cell-a', 'cell-b', 2)).toBe(2)
    expect(await store.startActiveCellEvacuations('cell-a', 'cell-b', 2)).toBe(1)
    expect(await store.startActiveCellEvacuations('cell-a', 'cell-b', 2)).toBe(0)
    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', false)).toEqual({
      inProgress: 3,
      oldestExpiresAt: 100 + ASSIGNMENT_LIMITS.migrationLeaseMs,
      oldestRemainingMs: ASSIGNMENT_LIMITS.migrationLeaseMs,
      targetRegistered: 0,
      ...NO_REGISTERED_EVACUATION_DIAGNOSTICS,
      completed: 0,
      blocked: 0,
      ...NO_EXPIRED_EVACUATION_DIAGNOSTICS
    })
    for (const identity of identities) {
      const assignment = await store.resolve(identity)
      await store.activateControl(identity, {
        cellId: 'cell-b',
        assignmentEpoch: assignment!.assignmentEpoch,
        generation: 2
      })
      await store.markMigrationTargetRegistered(identity, {
        cellId: 'cell-b',
        assignmentEpoch: assignment!.assignmentEpoch
      })
    }
    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', true)).toEqual({
      inProgress: 3,
      oldestExpiresAt: 100 + ASSIGNMENT_LIMITS.migrationLeaseMs,
      oldestRemainingMs: ASSIGNMENT_LIMITS.migrationLeaseMs,
      targetRegistered: 3,
      registeredSourceActive: 3,
      registeredCompletable: 0,
      registeredTargetInactive: 0,
      completed: 0,
      blocked: 3,
      ...NO_EXPIRED_EVACUATION_DIAGNOSTICS
    })
    for (let index = 0; index < identities.length; index++) {
      await store.releaseActivity(identities[index]!, sourceControls[index]!)
    }
    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', true)).toEqual({
      inProgress: 0,
      ...NO_ACTIVE_MIGRATION_LEASE,
      targetRegistered: 0,
      ...NO_REGISTERED_EVACUATION_DIAGNOSTICS,
      completed: 3,
      blocked: 0,
      ...NO_EXPIRED_EVACUATION_DIAGNOSTICS
    })
  })

  it.each(['cell-b', 'cell-c'])(
    'skips a batch row that concurrently moved from the selected source to %s',
    async (movedCellId) => {
      const store = await setup(() => 100, [
        { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 },
        { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 20 },
        { id: 'cell-c', url: 'https://relay-c.example.com', capacityRequests: 20 }
      ])
      const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
      const assignment = await store.assign(identity)
      await store.activateControl(identity, {
        cellId: 'cell-a',
        assignmentEpoch: assignment.assignmentEpoch,
        generation: 1
      })
      const startEvacuation = store.startEvacuation.bind(store)
      vi.spyOn(store, 'startEvacuation').mockImplementationOnce(async (...args) => {
        await database!.query(
          `UPDATE relay_assignments SET cell_id = ? WHERE user_id = ? AND relay_host_id = ?`,
          [movedCellId, identity.userId, identity.relayHostId]
        )
        return await startEvacuation(...args)
      })

      expect(await store.startActiveCellEvacuations('cell-a', 'cell-b', 10)).toBe(0)
      expect(await store.resolve(identity)).toMatchObject({ cellId: movedCellId })
      expect(await database!.query(`SELECT * FROM relay_assignment_migrations`)).toEqual([])
    }
  )

  it('does not count an existing migration after a stale batch row moves to its target', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 20 }
    ])
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const assignment = await store.assign(identity)
    await store.activateControl(identity, {
      cellId: 'cell-a',
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    const startEvacuation = store.startEvacuation.bind(store)
    vi.spyOn(store, 'startEvacuation').mockImplementationOnce(async (...args) => {
      await startEvacuation(identity, 'cell-b')
      return await startEvacuation(...args)
    })

    expect(await store.startActiveCellEvacuations('cell-a', 'cell-b', 10)).toBe(0)
    expect(await store.resolve(identity)).toMatchObject({ cellId: 'cell-b' })
    expect(await store.cellEvacuationStatus('cell-a', 'cell-b', false)).toMatchObject({
      inProgress: 1
    })
  })

  it('preserves operator-owned tagged URLs and admission state across reconciliation', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 }
    ])
    await store.configureCell(
      { id: 'cell-a', url: 'https://old---relay-a.example.com', capacityRequests: 20 },
      false
    )
    await store.reconcileCells([
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 }
    ])
    const rows = await database!.query(
      `SELECT cell_url, enabled, capacity_requests FROM relay_cells WHERE cell_id = ?`,
      ['cell-a']
    )
    expect(rows).toEqual([
      {
        cell_url: 'https://old---relay-a.example.com',
        enabled: 0,
        capacity_requests: 20
      }
    ])
  })

  it('bulk-migrates activity even when its source control is temporarily absent', async () => {
    const store = await setup(() => 100, [
      { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 20 },
      { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 20 }
    ])
    const identity = { userId: 'user-1', relayHostId: 'host000000000001' }
    const assignment = await store.assign(identity)
    const control = await store.activateControl(identity, {
      cellId: 'cell-a',
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    await store.acquireActivity(identity, {
      activityId: 'splice-without-control',
      kind: 'splice',
      cellId: 'cell-a'
    })
    await store.releaseActivity(identity, control)
    expect(await store.cellEvacuationCapacity('cell-a', 'cell-b')).toEqual({
      sourceAssignments: 1,
      requiredTargetUnits: 3,
      availableTargetUnits: 20
    })
    expect(await store.startActiveCellEvacuations('cell-a', 'cell-b', 10)).toBe(1)
    expect(await store.resolve(identity)).toMatchObject({ cellId: 'cell-b', assignmentEpoch: 2 })
  })
})

async function cellReservations(database: RelayDatabase): Promise<Record<string, number>> {
  const rows = await database.query(
    `SELECT cell_id, reserved_requests FROM relay_cells ORDER BY cell_id ASC`
  )
  return Object.fromEntries(rows.map((row) => [String(row.cell_id), Number(row.reserved_requests)]))
}
