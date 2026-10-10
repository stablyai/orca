import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  RelayAssignmentStore,
  STRANDED_MIGRATION_ABANDON_MS,
  type RelayAssignmentMigration
} from './assignment-store.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'
import { readRegisteredMigrationInventory } from './registered-migration-inventory.js'

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
    await database.query(`DELETE FROM relay_cells WHERE cell_id LIKE 'recovery-cell-%'`)
    await database.close()
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

  it('reaps an abandoned registered migration onto its healthy target', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)
    await input.store.releaseActivity(input.identity, input.targetControlId)
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
          AND migration.assignment_epoch = assignment.assignment_epoch
         WHERE assignment.user_id = ? AND assignment.relay_host_id = ?`,
        [input.identity.userId, input.identity.relayHostId]
      )
    ).toEqual([
      {
        cell_id: input.cells.failed.id,
        assignment_epoch: '2',
        completed_at: String(
          100 + ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1
        ),
        aborted_at: null
      }
    ])
  })

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

  it('reaps immediately after the retired source has an adopted legacy fence', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)
    await input.store.releaseActivity(input.identity, input.targetControlId)
    input.advancePastHeartbeat()
    await input.store.adoptLegacyCellFence(
      input.cells.source.id,
      input.cellIncarnation
    )
    await input.store.commitLegacyCellFenceAdoption(
      input.cells.source.id,
      input.cellIncarnation
    )
    input.advance(ASSIGNMENT_LIMITS.migrationLeaseMs + 1)

    expect(
      (
        await readRegisteredMigrationInventory(
          database,
          100 + 45_001 + ASSIGNMENT_LIMITS.migrationLeaseMs + 1
        )
      ).abandoned
    ).toBe(1)

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

  it('does not reap after temporary legacy adoption without durable commit', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)
    await input.store.releaseActivity(input.identity, input.targetControlId)
    input.advancePastHeartbeat()
    await input.store.adoptLegacyCellFence(
      input.cells.source.id,
      input.cellIncarnation
    )
    input.advance(ASSIGNMENT_LIMITS.migrationLeaseMs + 1)

    expect(
      (
        await readRegisteredMigrationInventory(
          database,
          100 + 45_001 + ASSIGNMENT_LIMITS.migrationLeaseMs + 1
        )
      ).abandoned
    ).toBe(0)
    await expect(input.store.abortExpiredEvacuations()).resolves.toBe(0)
    input.advance(STRANDED_MIGRATION_ABANDON_MS)
    await expect(input.store.abortExpiredEvacuations()).resolves.toBe(1)
  })

  it('invalidates an adopted legacy fence when the source heartbeats', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)
    await input.store.releaseActivity(input.identity, input.targetControlId)
    input.advancePastHeartbeat()
    await input.store.adoptLegacyCellFence(
      input.cells.source.id,
      input.cellIncarnation
    )
    await input.store.commitLegacyCellFenceAdoption(
      input.cells.source.id,
      input.cellIncarnation
    )
    input.advance(ASSIGNMENT_LIMITS.migrationLeaseMs + 1)
    await input.heartbeat(input.cells.source)

    expect(
      await database.query(
        `SELECT cell_id FROM relay_cell_legacy_fence_adoptions WHERE cell_id = ?`,
        [input.cells.source.id]
      )
    ).toEqual([])
    await expect(input.store.abortExpiredEvacuations()).resolves.toBe(0)
    input.advance(STRANDED_MIGRATION_ABANDON_MS)
    await expect(input.store.abortExpiredEvacuations()).resolves.toBe(1)
  })

  it('invalidates an adopted legacy fence when the source restarts', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)
    await input.store.releaseActivity(input.identity, input.targetControlId)
    input.advancePastHeartbeat()
    await input.store.adoptLegacyCellFence(
      input.cells.source.id,
      input.cellIncarnation
    )
    await input.store.commitLegacyCellFenceAdoption(
      input.cells.source.id,
      input.cellIncarnation
    )
    input.advance(ASSIGNMENT_LIMITS.migrationLeaseMs + 1)
    await input.store.recordCellHeartbeat({
      cellId: input.cells.source.id,
      cellUrl: input.cells.source.url,
      cellIncarnation: '99999999-9999-4999-8999-999999999999',
      startedAt: 51,
      ready: true,
      observedRequests: 0
    })

    expect(
      await database.query(
        `SELECT cell_id FROM relay_cell_legacy_fence_adoptions WHERE cell_id = ?`,
        [input.cells.source.id]
      )
    ).toEqual([])
    await expect(input.store.abortExpiredEvacuations()).resolves.toBe(0)
    input.advance(STRANDED_MIGRATION_ABANDON_MS)
    await expect(input.store.abortExpiredEvacuations()).resolves.toBe(1)
  })

  it('serializes legacy adoption with a returning source heartbeat', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)
    await input.store.releaseActivity(input.identity, input.targetControlId)
    input.advancePastHeartbeat()
    await input.store.adoptLegacyCellFence(
      input.cells.source.id,
      input.cellIncarnation
    )

    const [commit, heartbeatResult] = await Promise.allSettled([
      input.store.commitLegacyCellFenceAdoption(
        input.cells.source.id,
        input.cellIncarnation
      ),
      input.heartbeat(input.cells.source)
    ])
    expect(heartbeatResult.status).toBe('fulfilled')
    expect(['fulfilled', 'rejected']).toContain(commit.status)
    expect(
      await database.query(
        `SELECT cell_id FROM relay_cell_legacy_fence_adoptions WHERE cell_id = ?`,
        [input.cells.source.id]
      )
    ).toEqual([])
    input.advance(
      ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1
    )
    await expect(input.store.abortExpiredEvacuations()).resolves.toBe(1)
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

  it('restores the 24-hour guard when the fenced source restarts', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)
    await input.store.releaseActivity(input.identity, input.targetControlId)
    input.advancePastHeartbeat()
    await completeSourceFence(input)
    input.advance(ASSIGNMENT_LIMITS.migrationLeaseMs + 1)
    await input.store.recordCellHeartbeat({
      cellId: input.cells.source.id,
      cellUrl: input.cells.source.url,
      cellIncarnation: '99999999-9999-4999-8999-999999999999',
      startedAt: 51,
      ready: true,
      observedRequests: 0
    })

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

  it('serializes fenced cleanup with a returning source heartbeat', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)
    await input.store.releaseActivity(input.identity, input.targetControlId)
    input.advancePastHeartbeat()
    await completeSourceFence(input)
    input.advance(ASSIGNMENT_LIMITS.migrationLeaseMs + 1)

    const [cleanup, heartbeatResult] = await Promise.allSettled([
      input.store.abortExpiredEvacuations(),
      input.heartbeat(input.cells.source)
    ])
    expect(cleanup.status).toBe('fulfilled')
    expect(heartbeatResult.status).toBe('fulfilled')
    if (cleanup.status !== 'fulfilled') throw cleanup.reason
    if (heartbeatResult.status !== 'fulfilled') throw heartbeatResult.reason
    expect([0, 1]).toContain(cleanup.value)
    const migrations = await database.query(
      `SELECT completed_at, aborted_at FROM relay_assignment_migrations
       WHERE user_id = ? AND relay_host_id = ?`,
      [input.identity.userId, input.identity.relayHostId]
    )
    if (cleanup.value === 1) {
      expect(migrations[0]?.completed_at).not.toBeNull()
    } else {
      expect(migrations).toEqual([{ completed_at: null, aborted_at: null }])
      input.advance(STRANDED_MIGRATION_ABANDON_MS)
      await expect(input.store.abortExpiredEvacuations()).resolves.toBe(1)
    }
  })

  it('keeps a freshly retired source protected without a durable fence', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)
    await input.store.releaseActivity(input.identity, input.targetControlId)
    input.advance(ASSIGNMENT_LIMITS.migrationLeaseMs + 1)

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

  it('serializes cleanup against supersession without reporting a false target', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)
    await input.store.releaseActivity(input.identity, input.targetControlId)
    await input.store.setCellEnabled(input.cells.failed.id, false)
    input.advance(
      ASSIGNMENT_LIMITS.migrationLeaseMs + STRANDED_MIGRATION_ABANDON_MS + 1
    )
    await input.heartbeat(input.cells.source)
    await input.heartbeat(input.cells.replacement)
    await input.store.attestCellFence(input.cells.failed.id, input.cellIncarnation)

    const [cleanup, supersession] = await Promise.allSettled([
      input.store.abortExpiredEvacuations(),
      input.store.supersedeRegisteredCellEvacuations(
        input.cells.source.id,
        input.cells.failed.id,
        input.cells.replacement.id,
        100
      )
    ])
    expect(cleanup.status).toBe('fulfilled')
    if (cleanup.status !== 'fulfilled') throw cleanup.reason
    if (supersession.status === 'fulfilled') {
      expect([0, 1]).toContain(supersession.value)
      const assignment = await database.query(
        `SELECT cell_id FROM relay_assignments WHERE user_id = ?`,
        [input.identity.userId]
      )
      expect(assignment).toEqual([{
        cell_id:
          supersession.value === 1
            ? input.cells.replacement.id
            : input.cells.source.id
      }])
      if (supersession.value === 0) expect(cleanup.value).toBeGreaterThanOrEqual(1)
    } else {
      expect(cleanup.value).toBeGreaterThanOrEqual(1)
      expect(supersession.reason).toMatchObject({ message: 'migration_already_superseded' })
      expect(
        await database.query(
          `SELECT cell_id FROM relay_assignments WHERE user_id = ?`,
          [input.identity.userId]
        )
      ).toEqual([{ cell_id: input.cells.source.id }])
    }
  })

  it('completes a registered migration from a dead source idempotently', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)
    input.advancePastHeartbeat()
    await input.heartbeat(input.cells.failed)
    await input.store.attestCellFence(
      input.cells.source.id,
      input.cellIncarnation
    )
    const completion = {
      assignmentEpoch: input.migration.assignmentEpoch,
      sourceCellId: input.cells.source.id,
      targetCellId: input.cells.failed.id
    }

    await expect(
      input.store.cellEvacuationStatus(
        input.cells.source.id,
        input.cells.failed.id,
        true
      )
    ).resolves.toMatchObject({ inProgress: 0, completed: 1 })
    await expect(
      input.store.completeEvacuationFromDeadSource(input.identity, completion)
    ).resolves.toMatchObject({ changed: false })
    expect(await reservations(input.cells)).toEqual({ source: 0, failed: 1, replacement: 0 })
  })

  it('fails dead-source completion without a stale source heartbeat', async () => {
    const input = await fixture()
    await input.store.releaseActivity(input.identity, input.sourceControlId)

    await expect(
      input.store.completeEvacuationFromDeadSource(input.identity, {
        assignmentEpoch: input.migration.assignmentEpoch,
        sourceCellId: input.cells.source.id,
        targetCellId: input.cells.failed.id
      })
    ).rejects.toThrow('cell_fence_attestation_missing')
    expect(await reservations(input.cells)).toEqual({ source: 0, failed: 2, replacement: 0 })
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

  it('reconciles durable cell accounting before aggregate supersession', async () => {
    const input = await fixture()
    await input.store.setCellEnabled(input.cells.failed.id, false)
    input.advancePastHeartbeat()
    await input.heartbeat(input.cells.source)
    await input.heartbeat(input.cells.replacement)
    await input.store.attestCellFence(
      input.cells.failed.id,
      input.cellIncarnation
    )
    await database.query(
      `UPDATE relay_cells
       SET reserved_requests = CASE WHEN cell_id = ? THEN 1 ELSE 0 END
       WHERE cell_id IN (?, ?)`,
      [input.cells.replacement.id, input.cells.source.id, input.cells.replacement.id]
    )

    await expect(
      input.store.supersedeRegisteredCellEvacuations(
        input.cells.source.id,
        input.cells.failed.id,
        input.cells.replacement.id,
        100
      )
    ).resolves.toBe(1)
    expect(await reservations(input.cells)).toEqual({
      source: 1,
      failed: 0,
      replacement: 2
    })
  })

  it('rebuilds an expired registered migration lease before supersession', async () => {
    const input = await fixture()
    await pinMigration(input, input.migration.assignmentEpoch)
    await clearActivities(input)
    await database.query(
      `UPDATE relay_assignment_migrations SET expires_at = 0
       WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
      [input.identity.userId, input.identity.relayHostId, input.migration.assignmentEpoch]
    )
    await fenceFailedCell(input)

    await expect(supersedeAggregate(input)).resolves.toBe(1)
    expect(await reservations(input.cells)).toEqual({
      source: 0,
      failed: 0,
      replacement: 1
    })
    expect(
      await database.query(
        `SELECT assignment_epoch, source_request_units, target_reserved_units, aborted_at
         FROM relay_assignment_migrations WHERE user_id = ? ORDER BY assignment_epoch`,
        [input.identity.userId]
      )
    ).toEqual([
      {
        assignment_epoch: '2',
        source_request_units: '1',
        target_reserved_units: '2',
        aborted_at: '45101'
      },
      {
        assignment_epoch: '3',
        source_request_units: '0',
        target_reserved_units: '1',
        aborted_at: null
      }
    ])
  })

  it('retires an obsolete row without discarding replacement activity', async () => {
    const input = await fixture()
    await pinMigration(input, input.migration.assignmentEpoch)
    await fenceFailedCell(input)
    await input.store.supersedeRegisteredEvacuation(input.identity, {
      assignmentEpoch: input.migration.assignmentEpoch,
      sourceCellId: input.cells.source.id,
      currentTargetCellId: input.cells.failed.id,
      replacementTargetCellId: input.cells.replacement.id
    })
    await database.query(
      `UPDATE relay_assignment_migrations SET aborted_at = NULL
       WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
      [input.identity.userId, input.identity.relayHostId, input.migration.assignmentEpoch]
    )
    const activityBefore = await assignmentActivities(input)

    await expect(supersedeAggregate(input)).resolves.toBe(1)
    expect(await assignmentActivities(input)).toEqual(activityBefore)
    expect(await reservations(input.cells)).toEqual({
      source: 1,
      failed: 0,
      replacement: 2
    })
    expect(
      await database.query(
        `SELECT assignment_epoch, aborted_at FROM relay_assignment_migrations
         WHERE user_id = ? ORDER BY assignment_epoch`,
        [input.identity.userId]
      )
    ).toEqual([
      { assignment_epoch: '2', aborted_at: '45101' },
      { assignment_epoch: '3', aborted_at: null }
    ])
  })

  it('anchors a newer dormant failed-cell epoch and preserves drain evidence', async () => {
    const input = await fixture()
    const drainAttemptId = await pinMigration(input, input.migration.assignmentEpoch)
    await clearActivities(input)
    await database.query(
      `UPDATE relay_assignments SET assignment_epoch = 4
       WHERE user_id = ? AND relay_host_id = ?`,
      [input.identity.userId, input.identity.relayHostId]
    )
    await database.query(
      `UPDATE relay_assignment_migrations SET expires_at = 0
       WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
      [input.identity.userId, input.identity.relayHostId, input.migration.assignmentEpoch]
    )
    await fenceFailedCell(input)

    await expect(supersedeAggregate(input)).resolves.toBe(1)
    expect(await reservations(input.cells)).toEqual({
      source: 0,
      failed: 0,
      replacement: 1
    })
    expect(
      await database.query(
        `SELECT assignment_epoch, source_request_units, target_reserved_units, aborted_at
         FROM relay_assignment_migrations WHERE user_id = ? ORDER BY assignment_epoch`,
        [input.identity.userId]
      )
    ).toEqual([
      {
        assignment_epoch: '2',
        source_request_units: '1',
        target_reserved_units: '2',
        aborted_at: '45101'
      },
      {
        assignment_epoch: '4',
        source_request_units: '0',
        target_reserved_units: '1',
        aborted_at: '45101'
      },
      {
        assignment_epoch: '5',
        source_request_units: '0',
        target_reserved_units: '1',
        aborted_at: null
      }
    ])
    expect(
      await database.query(
        `SELECT assignment_epoch, drain_attempt_id, source_request_units,
           target_reserved_units
         FROM relay_post_drain_migration_pins
         WHERE user_id = ? ORDER BY assignment_epoch`,
        [input.identity.userId]
      )
    ).toEqual([
      {
        assignment_epoch: '2',
        drain_attempt_id: drainAttemptId,
        source_request_units: '1',
        target_reserved_units: '2'
      },
      {
        assignment_epoch: '4',
        drain_attempt_id: drainAttemptId,
        source_request_units: '0',
        target_reserved_units: '1'
      },
      {
        assignment_epoch: '5',
        drain_attempt_id: drainAttemptId,
        source_request_units: '0',
        target_reserved_units: '1'
      }
    ])
  })

  it('uses an existing current-epoch migration once when retiring an older row', async () => {
    const input = await fixture()
    await pinMigration(input, input.migration.assignmentEpoch)
    await clearActivities(input)
    await database.query(
      `UPDATE relay_assignments SET assignment_epoch = 4
       WHERE user_id = ? AND relay_host_id = ?`,
      [input.identity.userId, input.identity.relayHostId]
    )
    await database.query(
      `INSERT INTO relay_assignment_migrations
       (user_id, relay_host_id, source_cell_id, target_cell_id,
        previous_epoch, assignment_epoch, source_request_units,
        target_reserved_units, expires_at, target_registered_at,
        completed_at, aborted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 2, 4, 0, 1, 0, 100, NULL, NULL, 100, 100)`,
      [
        input.identity.userId,
        input.identity.relayHostId,
        input.cells.source.id,
        input.cells.failed.id
      ]
    )
    await database.query(
      `INSERT INTO relay_assignment_migration_incarnations
       (user_id, relay_host_id, assignment_epoch, source_cell_incarnation,
        target_cell_incarnation)
       VALUES (?, ?, 4, ?, ?)`,
      [
        input.identity.userId,
        input.identity.relayHostId,
        input.cellIncarnation,
        input.cellIncarnation
      ]
    )
    await pinMigration(input, 4)
    await fenceFailedCell(input)

    await expect(supersedeAggregate(input)).resolves.toBe(1)
    expect(
      await database.query(
        `SELECT assignment_epoch, aborted_at FROM relay_assignment_migrations
         WHERE user_id = ? ORDER BY assignment_epoch`,
        [input.identity.userId]
      )
    ).toEqual([
      { assignment_epoch: '2', aborted_at: '45101' },
      { assignment_epoch: '4', aborted_at: '45101' },
      { assignment_epoch: '5', aborted_at: null }
    ])
    expect(await reservations(input.cells)).toEqual({
      source: 0,
      failed: 0,
      replacement: 1
    })
  })

  it('rejects a newer failed-cell epoch with ambiguous activity', async () => {
    const input = await fixture()
    await database.query(
      `UPDATE relay_assignments SET assignment_epoch = 4
       WHERE user_id = ? AND relay_host_id = ?`,
      [input.identity.userId, input.identity.relayHostId]
    )
    await fenceFailedCell(input)

    await expect(supersedeAggregate(input)).rejects.toThrow(
      'migration_activity_topology_mismatch'
    )
    expect(
      await database.query(
        `SELECT assignment_epoch, aborted_at FROM relay_assignment_migrations
         WHERE user_id = ?`,
        [input.identity.userId]
      )
    ).toEqual([{ assignment_epoch: '2', aborted_at: null }])
    expect(await reservations(input.cells)).toEqual({
      source: 1,
      failed: 2,
      replacement: 0
    })
  })

  it('leaves lease repair retryable when supersession later fails', async () => {
    const input = await fixture(1)
    await database.query(
      `DELETE FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ? AND activity_kind = 'migration'`,
      [input.identity.userId, input.identity.relayHostId]
    )
    await database.query(
      `UPDATE relay_assignments SET migration_leases = 0
       WHERE user_id = ? AND relay_host_id = ?`,
      [input.identity.userId, input.identity.relayHostId]
    )
    await database.query(
      `UPDATE relay_cells SET reserved_requests = reserved_requests - 1
       WHERE cell_id = ?`,
      [input.cells.failed.id]
    )
    await database.query(
      `UPDATE relay_assignment_migrations SET expires_at = 0
       WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
      [input.identity.userId, input.identity.relayHostId, input.migration.assignmentEpoch]
    )
    await fenceFailedCell(input)

    await expect(supersedeAggregate(input)).rejects.toThrow(
      'relay_capacity_exhausted'
    )
    expect(
      await database.query(
        `SELECT activity_id FROM relay_assignment_activity_leases
         WHERE user_id = ? AND activity_kind = 'migration'`,
        [input.identity.userId]
      )
    ).toEqual([{ activity_id: 'migration:2' }])
    expect(
      await database.query(
        `SELECT aborted_at FROM relay_assignment_migrations
         WHERE user_id = ? AND assignment_epoch = 2`,
        [input.identity.userId]
      )
    ).toEqual([{ aborted_at: null }])

    await database.query(
      `UPDATE relay_cells SET capacity_requests = 2 WHERE cell_id = ?`,
      [input.cells.replacement.id]
    )
    await expect(supersedeAggregate(input)).resolves.toBe(1)
    expect(await reservations(input.cells)).toEqual({
      source: 1,
      failed: 0,
      replacement: 2
    })
  })

  it('serializes concurrent supersession retries without duplicating capacity', async () => {
    const input = await fixture()
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

    const results = await Promise.all([
      input.store.supersedeRegisteredEvacuation(input.identity, supersession),
      input.store.supersedeRegisteredEvacuation(input.identity, supersession)
    ])
    expect(results[0]).toEqual(results[1])
    expect(await reservations(input.cells)).toEqual({ source: 1, failed: 0, replacement: 2 })
    expect(
      await database.query(
        `SELECT COUNT(*) AS count FROM relay_assignment_migrations WHERE user_id = ?`,
        [input.identity.userId]
      )
    ).toEqual([{ count: '2' }])
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

  it('rolls back supersession when migration request-unit shape drifted', async () => {
    const input = await fixture()
    await input.store.setCellEnabled(input.cells.failed.id, false)
    input.advancePastHeartbeat()
    await input.heartbeat(input.cells.source)
    await input.heartbeat(input.cells.replacement)
    await input.store.attestCellFence(input.cells.failed.id, input.cellIncarnation)
    await database.query(
      `UPDATE relay_assignment_activity_leases
       SET request_units = request_units + 1
       WHERE user_id = ? AND activity_kind = 'migration'`,
      [input.identity.userId]
    )
    await database.query(
      `UPDATE relay_cells SET reserved_requests = reserved_requests + 1 WHERE cell_id = ?`,
      [input.cells.failed.id]
    )

    await expect(
      input.store.supersedeRegisteredEvacuation(input.identity, {
        assignmentEpoch: input.migration.assignmentEpoch,
        sourceCellId: input.cells.source.id,
        currentTargetCellId: input.cells.failed.id,
        replacementTargetCellId: input.cells.replacement.id
      })
    ).rejects.toThrow('migration_activity_lease_shape_mismatch')
    expect(await reservations(input.cells)).toEqual({ source: 1, failed: 3, replacement: 0 })
    expect(
      await database.query(
        `SELECT cell_id, assignment_epoch FROM relay_assignments WHERE user_id = ?`,
        [input.identity.userId]
      )
    ).toEqual([{ cell_id: input.cells.failed.id, assignment_epoch: '2' }])
  })

  it('rolls back supersession when locked cell reservation accounting drifted', async () => {
    const input = await fixture()
    await input.store.setCellEnabled(input.cells.failed.id, false)
    input.advancePastHeartbeat()
    await input.heartbeat(input.cells.source)
    await input.heartbeat(input.cells.replacement)
    await input.store.attestCellFence(input.cells.failed.id, input.cellIncarnation)
    await database.query(
      `UPDATE relay_cells SET reserved_requests = 1 WHERE cell_id = ?`,
      [input.cells.replacement.id]
    )

    await expect(
      input.store.supersedeRegisteredEvacuation(input.identity, {
        assignmentEpoch: input.migration.assignmentEpoch,
        sourceCellId: input.cells.source.id,
        currentTargetCellId: input.cells.failed.id,
        replacementTargetCellId: input.cells.replacement.id
      })
    ).rejects.toThrow('migration_cell_reservation_accounting_mismatch')
    expect(await reservations(input.cells)).toEqual({ source: 1, failed: 2, replacement: 1 })
    expect(
      await database.query(
        `SELECT assignment_epoch, aborted_at FROM relay_assignment_migrations
         WHERE user_id = ?`,
        [input.identity.userId]
      )
    ).toEqual([{ assignment_epoch: '2', aborted_at: null }])
  })

  it('rejects supersession before incrementing the maximum safe epoch', async () => {
    const input = await fixture()
    await expect(
      input.store.supersedeRegisteredEvacuation(input.identity, {
        assignmentEpoch: Number.MAX_SAFE_INTEGER,
        sourceCellId: input.cells.source.id,
        currentTargetCellId: input.cells.failed.id,
        replacementTargetCellId: input.cells.replacement.id
      })
    ).rejects.toThrow('assignment_epoch_exhausted')
  })

  async function fenceFailedCell(input: RecoveryFixture): Promise<void> {
    await input.store.setCellEnabled(input.cells.failed.id, false)
    input.advancePastHeartbeat()
    await input.heartbeat(input.cells.source)
    await input.heartbeat(input.cells.replacement)
    await input.store.attestCellFence(
      input.cells.failed.id,
      input.cellIncarnation
    )
  }

  async function supersedeAggregate(input: RecoveryFixture): Promise<number> {
    return await input.store.supersedeRegisteredCellEvacuations(
      input.cells.source.id,
      input.cells.failed.id,
      input.cells.replacement.id,
      100
    )
  }

  async function clearActivities(input: RecoveryFixture): Promise<void> {
    await database.query(
      `DELETE FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ?`,
      [input.identity.userId, input.identity.relayHostId]
    )
    await database.query(
      `UPDATE relay_assignments SET reserved_controls = 0, reserved_splices = 0,
         reserved_invites = 0, pending_installs = 0, pending_confirmations = 0,
         migration_leases = 0
       WHERE user_id = ? AND relay_host_id = ?`,
      [input.identity.userId, input.identity.relayHostId]
    )
    await database.query(
      `UPDATE relay_cells SET reserved_requests = 0
       WHERE cell_id IN (?, ?, ?)`,
      [input.cells.source.id, input.cells.failed.id, input.cells.replacement.id]
    )
  }

  async function pinMigration(
    input: RecoveryFixture,
    assignmentEpoch: number
  ): Promise<string> {
    const drainAttemptId = `${input.identity.userId}-drain-${assignmentEpoch}`
    await database.query(
      `INSERT INTO relay_post_drain_migration_pins
       (user_id, relay_host_id, assignment_epoch, drain_attempt_id,
        source_cell_id, source_cell_incarnation, target_cell_id,
        target_cell_incarnation, source_request_units, target_reserved_units,
        pinned_at)
       SELECT migration.user_id, migration.relay_host_id,
         migration.assignment_epoch, ?, migration.source_cell_id,
         incarnation.source_cell_incarnation, migration.target_cell_id,
         incarnation.target_cell_incarnation, migration.source_request_units,
         migration.target_reserved_units, 100
       FROM relay_assignment_migrations migration
       JOIN relay_assignment_migration_incarnations incarnation
         ON incarnation.user_id = migration.user_id
        AND incarnation.relay_host_id = migration.relay_host_id
        AND incarnation.assignment_epoch = migration.assignment_epoch
       WHERE migration.user_id = ? AND migration.relay_host_id = ?
         AND migration.assignment_epoch = ?`,
      [
        drainAttemptId,
        input.identity.userId,
        input.identity.relayHostId,
        assignmentEpoch
      ]
    )
    return drainAttemptId
  }

  async function assignmentActivities(input: RecoveryFixture): Promise<unknown[]> {
    return await database.query(
      `SELECT activity_id, activity_kind, cell_id, request_units
       FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ? ORDER BY activity_id`,
      [input.identity.userId, input.identity.relayHostId]
    )
  }

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
