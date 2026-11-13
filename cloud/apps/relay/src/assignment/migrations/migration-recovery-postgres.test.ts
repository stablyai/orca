import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract/assignment-invariants'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  RelayAssignmentStore,
  STRANDED_MIGRATION_ABANDON_MS,
  type RelayAssignmentMigration
} from '../assignment-store.js'
import { openRelayDatabase, type RelayDatabase } from '../../database/database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

type RecoveryFixture = {
  store: RelayAssignmentStore
  identity: { userId: string; relayHostId: string }
  migration: RelayAssignmentMigration
  sourceControlId: string
  targetControlId: string
  cellIncarnation: string
  cells: {
    source: { id: string; url: string; capacityRequests: number }
    failed: { id: string; url: string; capacityRequests: number }
    replacement: { id: string; url: string; capacityRequests: number }
  }
  advancePastHeartbeat: () => void
  advance: (milliseconds: number) => void
  heartbeat: (cell: { id: string; url: string }) => Promise<void>
}

describePostgres('PostgreSQL migration recovery', () => {
  let database: RelayDatabase
  let sequence = 0

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '' })
  })

  afterAll(async () => {
    try {
      await database.query(
        `DELETE FROM relay_control_connection_reservations
       WHERE user_id LIKE 'recovery-user-%'`
      )
      await database.query(
        `DELETE FROM relay_post_drain_migration_pins WHERE user_id LIKE 'recovery-user-%'`
      )
      await database.query(
        `DELETE FROM relay_assignment_migration_incarnations WHERE user_id LIKE 'recovery-user-%'`
      )
      await database.query(
        `DELETE FROM relay_assignment_activity_leases WHERE user_id LIKE 'recovery-user-%'`
      )
      await database.query(
        `DELETE FROM relay_assignment_migrations WHERE user_id LIKE 'recovery-user-%'`
      )
      await database.query(
        `DELETE FROM relay_control_capabilities WHERE user_id LIKE 'recovery-user-%'`
      )
      await database.query(`DELETE FROM relay_assignments WHERE user_id LIKE 'recovery-user-%'`)
      await database.query(
        `DELETE FROM relay_cell_fence_apply_invocations WHERE attempt_id IN (
         SELECT attempt_id FROM relay_cell_fence_attempts
         WHERE cell_id LIKE 'recovery-cell-%'
       )`
      )
      await database.query(
        `DELETE FROM relay_cell_committed_fences WHERE cell_id LIKE 'recovery-cell-%'`
      )
      await database.query(
        `DELETE FROM relay_cell_legacy_fence_adoptions
       WHERE cell_id LIKE 'recovery-cell-%'`
      )
      await database.query(
        `DELETE FROM relay_cell_fence_plan_bindings WHERE attempt_id IN (
         SELECT attempt_id FROM relay_cell_fence_attempts
         WHERE cell_id LIKE 'recovery-cell-%'
       )`
      )
      await database.query(
        `DELETE FROM relay_cell_fence_attempts WHERE cell_id LIKE 'recovery-cell-%'`
      )
      await database.query(`DELETE FROM relay_cell_fences WHERE cell_id LIKE 'recovery-cell-%'`)
      await database.query(`DELETE FROM relay_cell_runtime WHERE cell_id LIKE 'recovery-cell-%'`)
      await database.query(`DELETE FROM relay_cell_admission WHERE cell_id LIKE 'recovery-cell-%'`)
      await database.query(`DELETE FROM relay_cell_regions WHERE cell_id LIKE 'recovery-cell-%'`)
      await database.query(`DELETE FROM relay_cells WHERE cell_id LIKE 'recovery-cell-%'`)
    } finally {
      await database?.close()
    }
  })

  async function fixture(replacementCapacity = 20): Promise<RecoveryFixture> {
    sequence++
    let now = 100
    const suffix = String(sequence)
    const cellIncarnation = `11111111-1111-4111-8111-${suffix.padStart(12, '0')}`
    const cells = {
      source: {
        id: `recovery-cell-${suffix}-source`,
        url: `https://recovery-${suffix}-source.example.com`,
        capacityRequests: 20
      },
      failed: {
        id: `recovery-cell-${suffix}-failed`,
        url: `https://recovery-${suffix}-failed.example.com`,
        capacityRequests: 20
      },
      replacement: {
        id: `recovery-cell-${suffix}-replacement`,
        url: `https://recovery-${suffix}-replacement.example.com`,
        capacityRequests: replacementCapacity
      }
    }
    const store = new RelayAssignmentStore(database, () => now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    await store.reconcileCells(Object.values(cells), false)
    const heartbeat = async (cell: { id: string; url: string }): Promise<void> => {
      await store.recordCellHeartbeat({
        cellId: cell.id,
        cellUrl: cell.url,
        cellIncarnation,
        startedAt: 50,
        ready: true,
        observedRequests: 0
      })
    }
    for (const cell of Object.values(cells)) await heartbeat(cell)
    const identity = {
      userId: `recovery-user-${suffix}`,
      relayHostId: `recoveryhost${suffix.padStart(4, '0')}`
    }
    const sourceControlId = `control:${cells.source.id}:1`
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity.userId,
        identity.relayHostId,
        cells.source.id,
        1,
        90_100,
        now,
        1,
        0,
        0,
        0,
        0,
        0
      ]
    )
    await database.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity.userId,
        identity.relayHostId,
        sourceControlId,
        'control',
        cells.source.id,
        1,
        90_100,
        now
      ]
    )
    await database.query(
      `UPDATE relay_cells SET reserved_requests = 1 WHERE cell_id = ?`,
      [cells.source.id]
    )
    await store.setCellEnabled(cells.source.id, false)
    const migration = await store.startEvacuation(identity, cells.failed.id)
    const targetControlId = await store.activateControl(identity, {
      cellId: cells.failed.id,
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: cells.failed.id,
      assignmentEpoch: migration.assignmentEpoch
    })
    return {
      store,
      identity,
      migration,
      sourceControlId,
      targetControlId,
      cellIncarnation,
      cells,
      advancePastHeartbeat: () => {
        now += 45_001
      },
      advance: (milliseconds) => {
        now += milliseconds
      },
      heartbeat
    }
  }

  async function completeSourceFence(input: RecoveryFixture): Promise<void> {
    const attemptId = input.cellIncarnation
    const invocationId = input.cellIncarnation
    const requestReason = `relay-recovery-test/${attemptId}`
    const evidence = {
      attemptId,
      environment: 'production' as const,
      cellId: input.cells.source.id,
      cellIncarnation: input.cellIncarnation,
      migName: input.cells.source.id,
      instanceGroup: `https://compute.example/instanceGroups/${input.cells.source.id}`,
      generationIdentity: `https://compute.example/instanceTemplates/${input.cells.source.id}`,
      fenceCommit: 'a'.repeat(40),
      planSha256: 'b'.repeat(64),
      planObjectName: `relay-fence-plans/${attemptId}.tfplan`,
      planObjectGeneration: '1',
      varFileSha256: 'c'.repeat(64),
      terraformStateLineage: input.cellIncarnation,
      terraformStateSerial: 1,
      terraformStateObjectGeneration: '1',
      terraformStateObjectSha256: 'd'.repeat(64),
      requestReason
    }
    await input.store.prepareCellFenceAttempt(evidence)
    await input.store.bindCellFencePlanGeneration(evidence, evidence.planObjectGeneration)
    await input.store.startCellFenceApply(
      evidence,
      invocationId,
      `${requestReason}/${invocationId}`
    )
    await input.store.recordCellFenceOperation(
      evidence,
      invocationId,
      `${requestReason}/${invocationId}`,
      `operation-${input.cells.source.id}`
    )
    await input.store.attestCellFenceAttempt(
      evidence,
      `operation-${input.cells.source.id}`
    )
  }

  it('reaps immediately after the retired source has a durable completed fence', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)
    await input.store.releaseActivity(input.identity, input.targetControlId)
    input.advancePastHeartbeat()
    await completeSourceFence(input)
    input.advance(ASSIGNMENT_LIMITS.migrationLeaseMs + 1)

    await expect(input.store.abortExpiredEvacuations()).resolves.toBe(1)
    expect(
      await database.query(
        `SELECT assignment.cell_id, assignment.assignment_epoch,
           migration.completed_at, migration.aborted_at
         FROM relay_assignments assignment
         JOIN relay_assignment_migrations migration
           ON migration.user_id = assignment.user_id
          AND migration.relay_host_id = assignment.relay_host_id
          AND migration.assignment_epoch = assignment.assignment_epoch
         WHERE assignment.user_id = ? AND assignment.relay_host_id = ?`,
        [input.identity.userId, input.identity.relayHostId]
      )
    ).toEqual([
      {
        cell_id: input.cells.failed.id,
        assignment_epoch: '2',
        completed_at: String(100 + 45_001 + ASSIGNMENT_LIMITS.migrationLeaseMs + 1),
        aborted_at: null
      }
    ])
  })

  it('restores the 24-hour guard when the fenced source heartbeats again', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)
    await input.store.releaseActivity(input.identity, input.targetControlId)
    input.advancePastHeartbeat()
    await completeSourceFence(input)
    input.advance(ASSIGNMENT_LIMITS.migrationLeaseMs + 1)
    await input.heartbeat(input.cells.source)

    await expect(input.store.abortExpiredEvacuations()).resolves.toBe(0)
    expect(
      await database.query(
        `SELECT completed_at, aborted_at FROM relay_assignment_migrations
         WHERE user_id = ? AND relay_host_id = ?`,
        [input.identity.userId, input.identity.relayHostId]
      )
    ).toEqual([{ completed_at: null, aborted_at: null }])
    input.advance(STRANDED_MIGRATION_ABANDON_MS)
    await expect(input.store.abortExpiredEvacuations()).resolves.toBe(1)
  })

  it('rolls an abandoned disabled target back to its source', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)
    await input.store.releaseActivity(input.identity, input.targetControlId)
    await input.store.setCellEnabled(input.cells.failed.id, false)
    input.advance(
      ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1
    )

    await expect(input.store.abortExpiredEvacuations()).resolves.toBe(1)
    expect(
      await database.query(
        `SELECT assignment.cell_id, assignment.assignment_epoch,
           migration.completed_at, migration.aborted_at
         FROM relay_assignments assignment
         JOIN relay_assignment_migrations migration
           ON migration.user_id = assignment.user_id
          AND migration.relay_host_id = assignment.relay_host_id
         WHERE assignment.user_id = ? AND assignment.relay_host_id = ?
         ORDER BY migration.assignment_epoch`,
        [input.identity.userId, input.identity.relayHostId]
      )
    ).toEqual([
      {
        cell_id: input.cells.source.id,
        assignment_epoch: '3',
        completed_at: null,
        aborted_at: String(
          100 + ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1
        )
      }
    ])
  })

  it('supersedes a registered migration with exact accounting and idempotency', async () => {
    const input = await fixture()
    await database.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id,
        assignment_epoch, cell_id, state, inclusion_watermark,
        claim_activity_id, created_at, timeout_at, claimed_at, released_at,
        updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'late-arrival-debt', NULL, NULL, 100, 100, NULL, NULL, 100)`,
      [
        `superseded-${input.identity.userId}`,
        `superseded-${input.identity.userId}`,
        input.identity.userId,
        input.identity.relayHostId,
        input.migration.assignmentEpoch,
        input.cells.failed.id
      ]
    )
    await input.store.setCellEnabled(input.cells.failed.id, false)
    input.advancePastHeartbeat()
    await input.heartbeat(input.cells.source)
    await input.heartbeat(input.cells.replacement)
    await input.store.attestCellFence(
      input.cells.failed.id,
      input.cellIncarnation
    )
    const supersession = {
      assignmentEpoch: input.migration.assignmentEpoch,
      sourceCellId: input.cells.source.id,
      currentTargetCellId: input.cells.failed.id,
      replacementTargetCellId: input.cells.replacement.id
    }

    const first = await input.store.supersedeRegisteredEvacuation(
      input.identity,
      supersession
    )
    const retry = await input.store.supersedeRegisteredEvacuation(
      input.identity,
      supersession
    )
    expect(retry).toEqual(first)
    expect(first).toMatchObject({ previousEpoch: 2, assignmentEpoch: 3 })
    expect(
      await database.query(
        `SELECT state FROM relay_control_connection_reservations
         WHERE reservation_id = ?`,
        [`superseded-${input.identity.userId}`]
      )
    ).toEqual([{ state: 'released' }])
    expect(await reservations(input.cells)).toEqual({ source: 1, failed: 0, replacement: 2 })
    expect(
      await database.query(
        `SELECT assignment_epoch, completed_at, aborted_at
         FROM relay_assignment_migrations WHERE user_id = ?
         ORDER BY assignment_epoch`,
        [input.identity.userId]
      )
    ).toEqual([
      { assignment_epoch: '2', completed_at: null, aborted_at: '45101' },
      { assignment_epoch: '3', completed_at: null, aborted_at: null }
    ])
  })

  it('fails a competing aggregate supersession instead of reporting the wrong target', async () => {
    const input = await fixture()
    const alternate = {
      id: `recovery-cell-${sequence}-alternate`,
      url: `https://recovery-${sequence}-alternate.example.com`,
      capacityRequests: 20
    }
    await input.store.reconcileCells([...Object.values(input.cells), alternate], false)
    await input.heartbeat(alternate)
    await input.store.setCellEnabled(input.cells.failed.id, false)
    input.advancePastHeartbeat()
    await input.heartbeat(input.cells.source)
    await input.heartbeat(input.cells.replacement)
    await input.heartbeat(alternate)
    await input.store.attestCellFence(input.cells.failed.id, input.cellIncarnation)

    const results = await Promise.allSettled([
      input.store.supersedeRegisteredCellEvacuations(
        input.cells.source.id,
        input.cells.failed.id,
        input.cells.replacement.id,
        100
      ),
      input.store.supersedeRegisteredCellEvacuations(
        input.cells.source.id,
        input.cells.failed.id,
        alternate.id,
        100
      )
    ])
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<number> => result.status === 'fulfilled'
    )
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    expect(fulfilled).toHaveLength(1)
    expect(fulfilled[0]!.value).toBe(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toMatchObject({ message: 'migration_already_superseded' })
    const successor = await database.query(
      `SELECT assignment.cell_id, migration.target_cell_id
       FROM relay_assignments assignment
       JOIN relay_assignment_migrations migration
         ON migration.user_id = assignment.user_id
        AND migration.relay_host_id = assignment.relay_host_id
        AND migration.assignment_epoch = assignment.assignment_epoch
       WHERE assignment.user_id = ? AND migration.previous_epoch = ?`,
      [input.identity.userId, input.migration.assignmentEpoch]
    )
    expect(successor).toHaveLength(1)
    expect(successor[0]!.cell_id).toBe(successor[0]!.target_cell_id)
    expect([input.cells.replacement.id, alternate.id]).toContain(
      successor[0]!.target_cell_id
    )
  })

  it('rolls back every supersession change when replacement capacity is insufficient', async () => {
    const input = await fixture(1)
    await input.store.setCellEnabled(input.cells.failed.id, false)
    input.advancePastHeartbeat()
    await input.heartbeat(input.cells.source)
    await input.heartbeat(input.cells.replacement)
    await input.store.attestCellFence(
      input.cells.failed.id,
      input.cellIncarnation
    )

    await expect(
      input.store.supersedeRegisteredEvacuation(input.identity, {
        assignmentEpoch: input.migration.assignmentEpoch,
        sourceCellId: input.cells.source.id,
        currentTargetCellId: input.cells.failed.id,
        replacementTargetCellId: input.cells.replacement.id
      })
    ).rejects.toThrow('relay_capacity_exhausted')
    expect(await reservations(input.cells)).toEqual({ source: 1, failed: 2, replacement: 0 })
    expect(
      await database.query(
        `SELECT cell_id, assignment_epoch FROM relay_assignments WHERE user_id = ?`,
        [input.identity.userId]
      )
    ).toEqual([{ cell_id: input.cells.failed.id, assignment_epoch: '2' }])
    expect(
      await database.query(
        `SELECT assignment_epoch, aborted_at FROM relay_assignment_migrations
         WHERE user_id = ?`,
        [input.identity.userId]
      )
    ).toEqual([{ assignment_epoch: '2', aborted_at: null }])
  })

  async function reservations(cells: RecoveryFixture['cells']): Promise<Record<string, number>> {
    const rows = await database.query(
      `SELECT cell_id, reserved_requests FROM relay_cells
       WHERE cell_id IN (?, ?, ?) ORDER BY cell_id`,
      [cells.source.id, cells.failed.id, cells.replacement.id]
    )
    return Object.fromEntries(
      rows.map((row) => {
        const cellId = String(row.cell_id)
        const name = cellId.endsWith('-source')
          ? 'source'
          : cellId.endsWith('-failed')
            ? 'failed'
            : 'replacement'
        return [name, Number(row.reserved_requests)]
      })
    )
  }
})
