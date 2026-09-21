import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { encodeMembership } from './cell-admission-selector.js'
import {
  openInMemoryRelayDatabase,
  type RelayDatabase,
  type RelayLockOptions,
  type SqlRow
} from './database.js'

const CELLS = [
  { id: 'c1', url: 'https://c1.example.com', capacityRequests: 20 },
  { id: 'c2', url: 'https://c2.example.com', capacityRequests: 20 },
  { id: 'c3', url: 'https://c3.example.com', capacityRequests: 20 }
]

const INITIAL_MEMBERSHIP = {
  existingOnly: ['c1'],
  migrationOnly: ['c2'],
  general: ['c3']
}
const BASE_MEMBERSHIP = {
  existingOnly: [],
  migrationOnly: [],
  general: ['c1', 'c2', 'c3']
}

class FailAfterIntentDatabase implements RelayDatabase {
  private transactionsUntilFailure = Number.POSITIVE_INFINITY

  constructor(private readonly delegate: RelayDatabase) {}

  failSecondTransaction(): void {
    this.transactionsUntilFailure = 2
  }

  async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    return await this.delegate.query(sql, params)
  }

  async queryLocked(
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]> {
    return await this.delegate.queryLocked(sql, params, options)
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    this.transactionsUntilFailure--
    if (this.transactionsUntilFailure === 0) {
      this.transactionsUntilFailure = Number.POSITIVE_INFINITY
      throw new Error('injected_commit_ambiguity')
    }
    return await this.delegate.transaction(operation)
  }

  async close(): Promise<void> {
    await this.delegate.close()
  }
}

class AfterTransactionDatabase implements RelayDatabase {
  private afterTransaction: (() => Promise<void>) | undefined

  constructor(private readonly delegate: RelayDatabase) {}

  runAfterNextTransaction(operation: () => Promise<void>): void {
    this.afterTransaction = operation
  }

  async query(sql: string, params?: unknown[]): Promise<SqlRow[]> {
    return await this.delegate.query(sql, params)
  }

  async queryLocked(
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]> {
    return await this.delegate.queryLocked(sql, params, options)
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    const result = await this.delegate.transaction(operation)
    const after = this.afterTransaction
    this.afterTransaction = undefined
    if (after) await after()
    return result
  }

  async close(): Promise<void> {
    await this.delegate.close()
  }
}

function membershipSha256(membership: typeof INITIAL_MEMBERSHIP): string {
  return createHash('sha256').update(encodeMembership(membership)).digest('hex')
}

const BASE_MEMBERSHIP_SHA256 = membershipSha256(BASE_MEMBERSHIP)

describe('relay cell admission selector', () => {
  let database: RelayDatabase | undefined

  afterEach(async () => await database?.close())

  async function setup(
    now: () => number,
    requireLiveCells = false
  ): Promise<RelayAssignmentStore> {
    database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, now, {
      requireLiveCells,
      heartbeatTtlMs: 45_000
    })
    await store.reconcileCells(CELLS)
    return store
  }

  async function heartbeat(store: RelayAssignmentStore, cellIndex: number): Promise<void> {
    const cell = CELLS[cellIndex]!
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: `${cellIndex + 1}1111111-1111-4111-8111-111111111111`,
      startedAt: 50,
      ready: true,
      observedRequests: 0
    })
  }

  it('preserves sticky assignments while reserving ordinary placement for general cells', async () => {
    const store = await setup(() => 100)
    const existing = { userId: 'existing', relayHostId: 'host000000000001' }
    expect(await store.assign(existing)).toMatchObject({ cellId: 'c1' })

    await store.applyCellAdmissionSelector({
      attemptId: 'cutover_001',
      expectedGeneration: 0,
      expectedMembershipSha256: BASE_MEMBERSHIP_SHA256,
      membership: INITIAL_MEMBERSHIP
    })

    expect(await store.assign(existing)).toMatchObject({ cellId: 'c1' })
    await expect(
      store.assign({ userId: 'new', relayHostId: 'host000000000002' })
    ).resolves.toMatchObject({ cellId: 'c3' })
    await expect(store.startEvacuation(existing, 'c2')).resolves.toMatchObject({
      sourceCellId: 'c1',
      targetCellId: 'c2'
    })
  })

  it('excludes existing-only and migration-only cells from dormant placement', async () => {
    let now = 100
    const store = await setup(() => now)
    const identity = { userId: 'dormant', relayHostId: 'host000000000001' }
    const assignment = await store.assign(identity)
    const control = await store.activateControl(identity, {
      cellId: assignment.cellId,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    await store.releaseActivity(identity, control)
    now += ASSIGNMENT_LIMITS.dormantTtlMs + 1

    await store.applyCellAdmissionSelector({
      attemptId: 'cutover_002',
      expectedGeneration: 0,
      expectedMembershipSha256: BASE_MEMBERSHIP_SHA256,
      membership: INITIAL_MEMBERSHIP
    })

    await expect(store.rebalanceDormant(identity, 'c2')).rejects.toThrow(
      'target_cell_unavailable'
    )
    await expect(store.rebalanceDormant(identity, 'c3')).resolves.toMatchObject({
      cellId: 'c3'
    })
  })

  it('does not recover an unfenced dead existing-only assignment', async () => {
    let now = 100
    const store = await setup(() => now, true)
    await heartbeat(store, 0)
    await heartbeat(store, 1)
    await heartbeat(store, 2)
    const identity = { userId: 'dead-source', relayHostId: 'host000000000001' }
    expect(await store.assign(identity)).toMatchObject({ cellId: 'c1' })
    await store.applyCellAdmissionSelector({
      attemptId: 'cutover_003',
      expectedGeneration: 0,
      expectedMembershipSha256: BASE_MEMBERSHIP_SHA256,
      membership: INITIAL_MEMBERSHIP
    })

    now += 45_001
    await heartbeat(store, 1)
    await heartbeat(store, 2)
    expect(await store.evacuateDeadCells()).toBe(0)
    expect(await store.resolve(identity)).toBeNull()
  })

  it('commits atomically and resolves an ambiguous response idempotently', async () => {
    const store = await setup(() => 100)
    const input = {
      attemptId: 'cutover_004',
      expectedGeneration: 0,
      expectedMembershipSha256: BASE_MEMBERSHIP_SHA256,
      membership: INITIAL_MEMBERSHIP
    }

    await expect(store.applyCellAdmissionSelector(input)).resolves.toMatchObject({
      changed: true,
      selector: { generation: 1, membership: INITIAL_MEMBERSHIP }
    })
    await expect(store.applyCellAdmissionSelector(input)).resolves.toMatchObject({
      changed: false,
      selector: { generation: 1, membership: INITIAL_MEMBERSHIP }
    })
    await expect(store.inspectCellAdmissionSelector(input.attemptId)).resolves.toMatchObject({
      intent: { state: 'committed' }
    })
    expect(await store.cellDeploymentStatus('c1')).toMatchObject({
      enabled: false,
      admissionState: 'existing-only'
    })
    expect(await store.cellDeploymentStatus('c2')).toMatchObject({
      enabled: true,
      admissionState: 'migration-only'
    })
  })

  it('rejects a generation-zero membership change between intent and commit', async () => {
    const delegate = await openInMemoryRelayDatabase()
    const hooked = new AfterTransactionDatabase(delegate)
    database = hooked
    const store = new RelayAssignmentStore(hooked, () => 100)
    await store.reconcileCells(CELLS)
    const inspected = (await store.inspectCellAdmissionSelector()).selector.membership
    const changed = {
      existingOnly: ['c2'],
      migrationOnly: [],
      general: ['c1', 'c3']
    }
    hooked.runAfterNextTransaction(async () => {
      await delegate.transaction(async (transaction) => {
        await transaction.query(
          `UPDATE relay_cells SET enabled = 0 WHERE cell_id = ?`,
          ['c2']
        )
        await transaction.query(
          `UPDATE relay_cell_admission SET admission_state = ? WHERE cell_id = ?`,
          ['existing-only', 'c2']
        )
        await transaction.query(
          `UPDATE relay_admission_selectors SET membership_json = ?
           WHERE selector_id = ? AND generation = 0`,
          [encodeMembership(changed), 'general']
        )
      })
    })

    await expect(store.applyCellAdmissionSelector({
      attemptId: 'cutover_race_001',
      expectedGeneration: 0,
      expectedMembershipSha256: membershipSha256(inspected),
      membership: inspected
    })).rejects.toThrow('admission_selector_membership_mismatch')
    await expect(store.applyCellAdmissionSelector({
      attemptId: 'cutover_race_001',
      expectedGeneration: 0,
      membership: inspected
    })).rejects.toThrow('admission_selector_membership_fingerprint_required')
    await expect(store.inspectCellAdmissionSelector()).resolves.toMatchObject({
      selector: { generation: 0, membership: changed }
    })
  })

  it('preserves admission age for cells unchanged by a selector CAS', async () => {
    let now = 100
    const store = await setup(() => now)
    await store.applyCellAdmissionSelector({
      attemptId: 'cutover_age_001',
      expectedGeneration: 0,
      expectedMembershipSha256: BASE_MEMBERSHIP_SHA256,
      membership: INITIAL_MEMBERSHIP
    })

    now = 200
    await store.applyCellAdmissionSelector({
      attemptId: 'cutover_age_002',
      expectedGeneration: 1,
      membership: {
        existingOnly: ['c1'],
        migrationOnly: [],
        general: ['c2', 'c3']
      }
    })

    expect(
      await database!.query(
        `SELECT cell_id, admission_state, updated_at
         FROM relay_cell_admission ORDER BY cell_id`
      )
    ).toEqual([
      { cell_id: 'c1', admission_state: 'existing-only', updated_at: 100 },
      { cell_id: 'c2', admission_state: 'general', updated_at: 200 },
      { cell_id: 'c3', admission_state: 'general', updated_at: 100 }
    ])
  })

  it('persists failed CAS intent without mutating current membership', async () => {
    const store = await setup(() => 100)
    await store.applyCellAdmissionSelector({
      attemptId: 'cutover_005',
      expectedGeneration: 0,
      expectedMembershipSha256: BASE_MEMBERSHIP_SHA256,
      membership: INITIAL_MEMBERSHIP
    })

    await expect(
      store.applyCellAdmissionSelector({
        attemptId: 'stale_attempt',
        expectedGeneration: 5,
        membership: {
          existingOnly: ['c1'],
          migrationOnly: [],
          general: ['c2', 'c3']
        }
      })
    ).rejects.toThrow('admission_selector_generation_mismatch')
    await expect(store.inspectCellAdmissionSelector('stale_attempt')).resolves.toMatchObject({
      selector: { generation: 1, membership: INITIAL_MEMBERSHIP },
      intent: { state: 'diverged' }
    })
  })

  it('rejects duplicate or incomplete selector membership before mutation', async () => {
    const store = await setup(() => 100)

    await expect(
      store.applyCellAdmissionSelector({
        attemptId: 'duplicate_001',
        expectedGeneration: 0,
        expectedMembershipSha256: BASE_MEMBERSHIP_SHA256,
        membership: {
          existingOnly: ['c1', 'c1'],
          migrationOnly: ['c2'],
          general: ['c3']
        }
      })
    ).rejects.toThrow('admission_selector_duplicate_cell')
    await expect(
      store.applyCellAdmissionSelector({
        attemptId: 'incomplete_001',
        expectedGeneration: 0,
        expectedMembershipSha256: BASE_MEMBERSHIP_SHA256,
        membership: {
          existingOnly: ['c1'],
          migrationOnly: ['c2'],
          general: []
        }
      })
    ).rejects.toThrow('admission_selector_incomplete_membership')
    await expect(store.inspectCellAdmissionSelector()).resolves.toMatchObject({
      selector: {
        generation: 0,
        membership: { existingOnly: [], migrationOnly: [], general: ['c1', 'c2', 'c3'] }
      }
    })
  })

  it('inspects an unchanged durable intent after an ambiguous apply failure', async () => {
    const underlying = await openInMemoryRelayDatabase()
    const failingDatabase = new FailAfterIntentDatabase(underlying)
    database = failingDatabase
    const store = new RelayAssignmentStore(failingDatabase, () => 100)
    await store.reconcileCells(CELLS)
    failingDatabase.failSecondTransaction()

    const input = {
      attemptId: 'ambiguous_001',
      expectedGeneration: 0,
      expectedMembershipSha256: BASE_MEMBERSHIP_SHA256,
      membership: INITIAL_MEMBERSHIP
    }
    await expect(store.applyCellAdmissionSelector(input)).rejects.toThrow(
      'injected_commit_ambiguity'
    )
    await expect(store.inspectCellAdmissionSelector(input.attemptId)).resolves.toMatchObject({
      selector: { generation: 0 },
      intent: { state: 'unchanged' }
    })
    await expect(store.applyCellAdmissionSelector(input)).resolves.toMatchObject({
      changed: true,
      selector: { generation: 1, membership: INITIAL_MEMBERSHIP }
    })
  })

  it('allows only one concurrent CAS and never re-enables legacy cells', async () => {
    const store = await setup(() => 100)
    await store.applyCellAdmissionSelector({
      attemptId: 'cutover_006',
      expectedGeneration: 0,
      expectedMembershipSha256: BASE_MEMBERSHIP_SHA256,
      membership: INITIAL_MEMBERSHIP
    })
    await expect(store.setCellEnabled('c1', true)).rejects.toThrow(
      'admission_selector_boundary_active'
    )

    const nextMembership = {
      existingOnly: ['c1'],
      migrationOnly: [],
      general: ['c2', 'c3']
    }
    const results = await Promise.allSettled([
      store.applyCellAdmissionSelector({
        attemptId: 'promote_001',
        expectedGeneration: 1,
        membership: nextMembership
      }),
      store.applyCellAdmissionSelector({
        attemptId: 'promote_002',
        expectedGeneration: 1,
        membership: nextMembership
      })
    ])
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)

    await expect(
      store.applyCellAdmissionSelector({
        attemptId: 'reenable_001',
        expectedGeneration: 2,
        membership: {
          existingOnly: [],
          migrationOnly: [],
          general: ['c1', 'c2', 'c3']
        }
      })
    ).rejects.toThrow('admission_selector_legacy_reenable')
  })

  it('preserves the selector boundary across compatible reconciliation', async () => {
    const store = await setup(() => 100)
    await store.applyCellAdmissionSelector({
      attemptId: 'cutover_007',
      expectedGeneration: 0,
      expectedMembershipSha256: BASE_MEMBERSHIP_SHA256,
      membership: INITIAL_MEMBERSHIP
    })

    await expect(store.reconcileCells(CELLS, false)).resolves.toBeUndefined()
    await expect(store.reconcileCells([CELLS[0]!, CELLS[2]!])).rejects.toThrow(
      'admission_selector_boundary_active'
    )
    await expect(store.inspectCellAdmissionSelector()).resolves.toMatchObject({
      selector: { generation: 1, membership: INITIAL_MEMBERSHIP }
    })
  })

  it('atomically adds exact migration-only cells after the selector boundary', async () => {
    const store = await setup(() => 100)
    await store.applyCellAdmissionSelector({
      attemptId: 'cutover_008',
      expectedGeneration: 0,
      expectedMembershipSha256: BASE_MEMBERSHIP_SHA256,
      membership: INITIAL_MEMBERSHIP
    })
    const input = {
      attemptId: 'add_cells_001',
      expectedGeneration: 1,
      cells: [
        {
          id: 'c5',
          url: 'https://c5.example.com',
          capacityRequests: 4_000,
          connectionHardCap: 1_000 as const,
          connectionUnobservedBound: 60
        },
        {
          id: 'c4',
          url: 'https://c4.example.com',
          capacityRequests: 4_000,
          connectionHardCap: 600 as const,
          connectionUnobservedBound: 60
        }
      ]
    }

    await expect(store.addMigrationCells(input)).resolves.toMatchObject({
      changed: true,
      selector: {
        generation: 2,
        attemptId: input.attemptId,
        membership: {
          existingOnly: ['c1'],
          migrationOnly: ['c2', 'c4', 'c5'],
          general: ['c3']
        }
      }
    })
    await expect(store.addMigrationCells(input)).resolves.toMatchObject({
      changed: false,
      selector: { generation: 2 }
    })
    await expect(store.inspectCellAdmissionSelector(input.attemptId)).resolves.toMatchObject({
      intent: { state: 'committed' }
    })
    await expect(store.cellDeploymentStatus('c4')).resolves.toMatchObject({
      enabled: true,
      admissionState: 'migration-only',
      cellUrl: 'https://c4.example.com',
      capacityRequests: 4_000,
      connectionCapacity: {
        hardCap: 600,
        unobservedBound: 60
      }
    })
    await expect(store.cellDeploymentStatus('c5')).resolves.toMatchObject({
      connectionCapacity: {
        hardCap: 1_000,
        ordinaryConnectionLimit: 900,
        normalAdmissionPause: 840
      }
    })
  })

  it('rejects additive cells before cutover and exact-attempt config reuse', async () => {
    const store = await setup(() => 100)
    const cell = {
      id: 'c4',
      url: 'https://c4.example.com',
      capacityRequests: 4_000,
      connectionHardCap: 600 as const,
      connectionUnobservedBound: 60
    }
    await expect(
      store.addMigrationCells({
        attemptId: 'add_cells_002',
        expectedGeneration: 0,
        cells: [cell]
      })
    ).rejects.toThrow('admission_selector_boundary_inactive')
    await store.applyCellAdmissionSelector({
      attemptId: 'cutover_009',
      expectedGeneration: 0,
      expectedMembershipSha256: BASE_MEMBERSHIP_SHA256,
      membership: INITIAL_MEMBERSHIP
    })
    await store.addMigrationCells({
      attemptId: 'add_cells_002',
      expectedGeneration: 1,
      cells: [cell]
    })
    await expect(
      store.addMigrationCells({
        attemptId: 'add_cells_002',
        expectedGeneration: 1,
        cells: [{ ...cell, capacityRequests: 3_999 }]
      })
    ).rejects.toThrow('admission_selector_attempt_mismatch')
    await expect(
      store.applyCellAdmissionSelector({
        attemptId: 'add_cells_002',
        expectedGeneration: 2,
        membership: {
          existingOnly: ['c1'],
          migrationOnly: ['c2', 'c4'],
          general: ['c3']
        }
      })
    ).rejects.toThrow('admission_selector_attempt_mismatch')
  })
})
