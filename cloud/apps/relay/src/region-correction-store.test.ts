import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openInMemoryRelayDatabase, openRelayDatabase, type RelayDatabase } from './database.js'

const identity = { userId: 'region-correction-test-user', relayHostId: 'abcdefghijklmnop' }
const cells = [
  {
    id: 'decision-us',
    url: 'https://decision-us.example.test',
    region: 'us-central1' as const,
    capacityRequests: 100
  },
  {
    id: 'decision-asia',
    url: 'https://decision-asia.example.test',
    region: 'asia-east2' as const,
    capacityRequests: 100
  }
]
const incarnations = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222'
]
const opened: RelayDatabase[] = []
afterEach(async () => {
  for (const database of opened.splice(0)) {
    if (database.dialect === 'postgres') await cleanupPostgres(database)
    await database.close()
  }
})

async function cleanupPostgres(database: RelayDatabase) {
  await database.query(
    `DELETE FROM relay_region_retentions WHERE attempt_id IN
    (SELECT attempt_id FROM relay_region_rehome_attempts WHERE user_id = ?)`,
    [identity.userId]
  )
  for (const table of [
    'relay_control_connection_reservations',
    'relay_region_decisions',
    'relay_control_capabilities',
    'relay_assignment_activity_leases',
    'relay_assignment_migrations',
    'relay_assignment_migration_incarnations',
    'relay_assignment_region_preferences',
    'relay_region_rehome_attempts',
    'relay_assignments'
  ]) {
    await database.query(`DELETE FROM ${table} WHERE user_id = ?`, [identity.userId])
  }
  for (const table of [
    'relay_cell_rehome_safety',
    'relay_cell_capabilities',
    'relay_cell_connection_snapshots',
    'relay_cell_connection_runtime',
    'relay_cell_runtime',
    'relay_cell_connection_limits',
    'relay_cell_admission',
    'relay_cell_regions',
    'relay_cells'
  ]) {
    await database.query(
      `DELETE FROM ${table} WHERE cell_id IN (?, ?)`,
      cells.map((cell) => cell.id)
    )
  }
}

async function setup() {
  const database =
    process.env.ORCA_REGION_CORRECTION_POSTGRES === '1'
      ? await openRelayDatabase({
          databaseUrl: requiredPostgresUrl(),
          dataDir: '/tmp/orca-region-correction-unused'
        })
      : await openInMemoryRelayDatabase()
  opened.push(database)
  if (database.dialect === 'postgres') await cleanupPostgres(database)
  let clock = 100_000_000
  const store = new RelayAssignmentStore(database, () => clock, {
    regionalRehomeCohortPercent: 100
  })
  await store.reconcileCells(cells)
  for (const cell of cells) await store.setCellEnabled(cell.id, true)
  for (const [index, cell] of cells.entries()) {
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      region: cell.region,
      cellIncarnation: incarnations[index]!,
      startedAt: clock - 1_000,
      ready: true,
      observedRequests: 0
    })
  }
  const assignment = await store.assign(identity, undefined, 'us-central1')
  const activityId = await store.activateControl(identity, {
    cellId: cells[0]!.id,
    assignmentEpoch: assignment.assignmentEpoch,
    generation: 7,
    cellIncarnation: incarnations[0],
    finishExistingRegionalRehome: true
  })
  return {
    database,
    store,
    assignment,
    activityId,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

function requiredPostgresUrl(): string {
  const url = process.env.ORCA_RELAY_TEST_POSTGRES_URL
  if (!url || new URL(url).port !== '55440')
    throw new Error('PostgreSQL tests require configured port 55440')
  return url
}

async function window(context: Awaited<ReturnType<typeof setup>>) {
  const result = await context.store.exchangeRegionCorrection(
    identity,
    { v: 1, action: 'issue-window' },
    context.assignment.assignmentEpoch
  )
  return result.window!
}

async function retainedMigration(context: Awaited<ReturnType<typeof setup>>) {
  const migration = await context.store.startEvacuation(identity, cells[1]!.id)
  const attemptId = '33333333-3333-4333-8333-333333333333'
  await context.database.query(
    `INSERT INTO relay_region_rehome_attempts
     (attempt_id,user_id,relay_host_id,preferred_region,source_cell_id,source_cell_incarnation,
      target_cell_id,target_cell_incarnation,previous_epoch,assignment_epoch,drain_grace_ms,send_attempts,created_at,updated_at)
     VALUES (?,?,?,'asia-east2',?,?,?,?,?,?,60000,1,?,?)`,
    [
      attemptId,
      identity.userId,
      identity.relayHostId,
      cells[0]!.id,
      incarnations[0],
      cells[1]!.id,
      incarnations[1],
      migration.previousEpoch,
      migration.assignmentEpoch,
      context.now(),
      context.now()
    ]
  )
  await context.database.query(
    `INSERT INTO relay_region_retentions (attempt_id,source_generation,source_activity_id) VALUES (?,7,?)`,
    [attemptId, context.activityId]
  )
  return {
    migration,
    retention: {
      mode: 'finish-existing' as const,
      attemptId,
      sourceGeneration: 7,
      sourceAssignmentEpoch: migration.previousEpoch
    }
  }
}

describe('ordered region decisions and exact retained authority', () => {
  it('reports aggregate retained lifecycle and reservations without identity disclosure or writes', async () => {
    const context = await setup()
    const { migration } = await retainedMigration(context)
    context.advance(1_000)
    const before = await context.database.query('SELECT * FROM relay_region_rehome_attempts')
    const outcomes = await context.store.regionCorrectionOutcomes()
    expect(outcomes).toEqual([
      expect.objectContaining({
        sourceCellId: cells[0]!.id,
        targetCellId: cells[1]!.id,
        state: 'registering',
        count: 1,
        oldestOpenMs: 1_000,
        retainedSources: 1
      })
    ])
    expect(outcomes[0]!.targetReservedUnits).toBeGreaterThan(0)
    expect(JSON.stringify(outcomes)).not.toContain(identity.relayHostId)
    expect(JSON.stringify(outcomes)).not.toContain(identity.userId)
    expect(await context.database.query('SELECT * FROM relay_region_rehome_attempts')).toEqual(
      before
    )
    await context.store.activateControl(identity, {
      cellId: cells[1]!.id,
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: cells[1]!.id,
      assignmentEpoch: migration.assignmentEpoch
    })
    expect(await context.store.regionCorrectionOutcomes()).toEqual([
      expect.objectContaining({ state: 'registered' })
    ])
    await context.store.releaseActivity(identity, context.activityId)
    expect(await context.store.completeReadyRegionalRehomes()).toBe(1)
    expect(await context.store.regionCorrectionOutcomes()).toEqual([
      expect.objectContaining({
        state: 'completed',
        retainedSources: 0,
        targetReservedUnits: 0,
        oldestOpenMs: 0
      })
    ])
  })

  it('supersedes prior windows and keeps an inconclusive tombstone immutable', async () => {
    const context = await setup()
    const first = await window(context)
    const second = await window(context)
    expect(second.generation).toBe(first.generation + 1)
    const report = {
      v: 1 as const,
      action: 'report' as const,
      assignmentEpoch: first.assignmentEpoch,
      policyVersion: 1 as const,
      outcome: 'conclusive' as const,
      measurements: { 'us-central1': 200, 'asia-east2': 40 }
    }
    expect(
      await context.store.exchangeRegionCorrection(
        identity,
        { ...report, generation: first.generation },
        first.assignmentEpoch
      )
    ).toMatchObject({ reportStatus: 'stale' })
    expect(
      await context.store.exchangeRegionCorrection(
        identity,
        { ...report, generation: second.generation, outcome: 'inconclusive', reason: 'jitter' },
        second.assignmentEpoch
      )
    ).toMatchObject({ reportStatus: 'accepted' })
    expect(
      await context.store.exchangeRegionCorrection(
        identity,
        { ...report, generation: second.generation },
        second.assignmentEpoch
      )
    ).toMatchObject({ reportStatus: 'duplicate' })
    expect(await context.store.previewRegionCorrection()).toEqual({ ineligible: 1 })
  })

  it('previews the uncapped fleet without writes, claims, or locked reads', async () => {
    const context = await setup()
    const query = context.database.query.bind(context.database)
    const transaction = context.database.transaction.bind(context.database)
    const queryLocked = context.database.queryLocked.bind(context.database)
    context.database.query = async (sql, params) => {
      expect(sql.trim()).toMatch(/^(SELECT|WITH)/i)
      return query(sql, params)
    }
    context.database.transaction = async () => {
      throw new Error('preview_must_not_open_mutating_transaction')
    }
    context.database.queryLocked = async () => {
      throw new Error('preview_must_not_lock')
    }
    try {
      const preview = await context.store.previewRegionalRehomeEligibility()
      expect(preview.counts['no-verified-decision']).toBeGreaterThanOrEqual(1)
      expect(preview.globalSafetyFailure).toBe('process-safety-unavailable')
      expect(JSON.stringify(preview)).not.toContain(identity.relayHostId)
      expect(JSON.stringify(preview)).not.toContain(identity.userId)
    } finally {
      context.database.query = query
      context.database.transaction = transaction
      context.database.queryLocked = queryLocked
    }
  })

  it('allocates distinct ordered generations for concurrent window issuers', async () => {
    const context = await setup()
    const replies = await Promise.all([window(context), window(context), window(context)])
    expect(replies.map((reply) => reply.generation).sort((a, b) => a - b)).toEqual([1, 2, 3])
    const older = replies.find((reply) => reply.generation === 2)!
    expect(
      await context.store.exchangeRegionCorrection(
        identity,
        {
          v: 1,
          action: 'report',
          generation: older.generation,
          assignmentEpoch: older.assignmentEpoch,
          policyVersion: 1,
          outcome: 'inconclusive',
          reason: 'delayed'
        },
        older.assignmentEpoch
      )
    ).toMatchObject({ reportStatus: 'stale' })
  })

  it('compares with assigned region, preserves hints, and never extends a window on report', async () => {
    const context = await setup()
    await context.store.assign(identity, 'asia-east2')
    const issued = await window(context)
    expect(issued.incumbentRegion).toBe('us-central1')
    context.advance(50)
    await context.store.exchangeRegionCorrection(
      identity,
      {
        v: 1,
        action: 'report',
        generation: issued.generation,
        assignmentEpoch: issued.assignmentEpoch,
        policyVersion: 1,
        outcome: 'conclusive',
        measurements: { 'us-central1': 110, 'asia-east2': 90 }
      },
      issued.assignmentEpoch
    )
    expect(await context.store.previewRegionCorrection()).toEqual({ ineligible: 1 })
    const row = (await context.database.query(`SELECT * FROM relay_region_decisions`))[0]!
    expect(Number(row.expires_at)).toBe(issued.expiresAt)
    const hint = (
      await context.database.query(
        `SELECT preferred_region FROM relay_assignment_region_preferences WHERE user_id = ?`,
        [identity.userId]
      )
    )[0]
    expect(hint?.preferred_region).toBe('asia-east2')
    context.advance(24 * 60 * 60_000)
    expect(
      await context.store.exchangeRegionCorrection(
        identity,
        {
          v: 1,
          action: 'report',
          generation: issued.generation,
          assignmentEpoch: issued.assignmentEpoch,
          policyVersion: 1,
          outcome: 'inconclusive',
          reason: 'late'
        },
        issued.assignmentEpoch
      )
    ).toMatchObject({ reportStatus: 'expired' })
  })

  it('rejects stale assignment basis and requires both thresholds', async () => {
    const context = await setup()
    const issued = await window(context)
    await context.store.exchangeRegionCorrection(
      identity,
      {
        v: 1,
        action: 'report',
        generation: issued.generation,
        assignmentEpoch: issued.assignmentEpoch,
        policyVersion: 1,
        outcome: 'conclusive',
        measurements: { 'us-central1': 150, 'asia-east2': 100 }
      },
      issued.assignmentEpoch
    )
    expect(await context.store.previewRegionCorrection()).toEqual({
      'us-central1-to-asia-east2': 1
    })
    await context.store.startEvacuation(identity, cells[1]!.id)
    expect(
      await context.store.exchangeRegionCorrection(
        identity,
        { v: 1, action: 'issue-window' },
        issued.assignmentEpoch
      )
    ).toMatchObject({ reportStatus: 'basis-changed' })
  })

  it('renews only the exact live retained attempt, generation and incarnation', async () => {
    const context = await setup()
    const { retention } = await retainedMigration(context)
    const input = {
      activityId: context.activityId,
      cellId: cells[0]!.id,
      cellIncarnation: incarnations[0],
      expiresAt: context.now() + 105_000,
      retention
    }
    await expect(context.store.renewControlActivity(identity, input)).resolves.toBeUndefined()
    await expect(
      context.store.renewControlActivity(identity, {
        ...input,
        retention: { ...retention, sourceGeneration: 8 }
      })
    ).rejects.toThrow('activity_cell_not_authoritative')
    await expect(
      context.store.renewControlActivity(identity, { ...input, cellIncarnation: incarnations[1] })
    ).rejects.toThrow('activity_cell_not_authoritative')
    await context.database.query(
      `UPDATE relay_region_rehome_attempts SET aborted_at = ? WHERE attempt_id = ?`,
      [context.now(), retention.attemptId]
    )
    await expect(context.store.renewControlActivity(identity, input)).rejects.toThrow(
      'activity_cell_not_authoritative'
    )
  })

  it('rejects retained renewal after authenticated capability replacement', async () => {
    const context = await setup()
    const { retention } = await retainedMigration(context)
    await context.database.query(
      `UPDATE relay_control_capabilities SET finish_existing = 0 WHERE user_id = ?`,
      [identity.userId]
    )
    await expect(
      context.store.renewControlActivity(identity, {
        activityId: context.activityId,
        cellId: cells[0]!.id,
        cellIncarnation: incarnations[0],
        retention,
        expiresAt: context.now() + 105_000
      })
    ).rejects.toThrow('activity_cell_not_authoritative')
  })

  it('reconciles a failed registered target without waiting for optimization age', async () => {
    const context = await setup()
    const { retention, migration } = await retainedMigration(context)
    const targetActivity = await context.store.activateControl(identity, {
      cellId: cells[1]!.id,
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: cells[1]!.id,
      assignmentEpoch: migration.assignmentEpoch
    })
    await context.store.releaseActivity(identity, targetActivity)
    context.advance(16 * 60_000)
    await context.store.renewControlActivity(identity, {
      activityId: context.activityId,
      cellId: cells[0]!.id,
      cellIncarnation: incarnations[0],
      retention,
      expiresAt: context.now() + 105_000
    })
    await context.store.recordCellHeartbeat({
      cellId: cells[0]!.id,
      cellUrl: cells[0]!.url,
      cellIncarnation: incarnations[0]!,
      startedAt: 99_999_000,
      ready: true,
      observedRequests: 1
    })
    expect(await context.store.refreshRegionalRehomeLeases()).toBe(0)
    expect(await context.store.abortExpiredEvacuations()).toBe(1)
    expect(
      await context.store.regionalRetentionRollback(identity, {
        cellId: cells[0]!.id,
        cellIncarnation: incarnations[0]!,
        activityId: context.activityId,
        retention,
        expiresAt: context.now() + 105_000
      })
    ).toMatchObject({ assignmentEpoch: migration.assignmentEpoch + 1, sourceGeneration: 7 })
  })

  it('keeps a registered retained migration beyond multiple days and completes on source release', async () => {
    const context = await setup()
    const { retention, migration } = await retainedMigration(context)
    const targetActivity = await context.store.activateControl(identity, {
      cellId: cells[1]!.id,
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await context.store.markMigrationTargetRegistered(identity, {
      cellId: cells[1]!.id,
      assignmentEpoch: migration.assignmentEpoch
    })
    context.advance(3 * 24 * 60 * 60_000)
    await context.store.renewControlActivity(identity, {
      activityId: context.activityId,
      cellId: cells[0]!.id,
      cellIncarnation: incarnations[0],
      retention,
      expiresAt: context.now() + 105_000
    })
    await context.store.renewControlActivity(identity, {
      activityId: targetActivity,
      cellId: cells[1]!.id,
      expiresAt: context.now() + 105_000
    })
    expect(await context.store.refreshRegionalRehomeLeases()).toBe(1)
    expect(await context.store.abortExpiredRegionalRehomes()).toBe(0)
    expect(await context.store.abortExpiredEvacuations()).toBe(0)
    expect(await context.store.completeReadyRegionalRehomes()).toBe(0)
    await context.store.recordCellHeartbeat({
      cellId: cells[1]!.id,
      cellUrl: cells[1]!.url,
      region: 'asia-east2',
      cellIncarnation: incarnations[1]!,
      startedAt: 99_999_000,
      ready: true,
      observedRequests: 1
    })
    await context.store.releaseActivity(identity, context.activityId)
    expect(await context.store.completeReadyRegionalRehomes()).toBe(1)
  })

  it('cannot regrant a released retained source or an expired requested rollback deadline', async () => {
    const context = await setup()
    const { retention } = await retainedMigration(context)
    const input = {
      activityId: context.activityId,
      cellId: cells[0]!.id,
      cellIncarnation: incarnations[0]!,
      retention,
      expiresAt: context.now()
    }
    expect(await context.store.regionalRetentionRollback(identity, input)).toBeNull()
    await context.store.releaseActivity(identity, context.activityId)
    await expect(
      context.store.renewControlActivity(identity, { ...input, expiresAt: context.now() + 105_000 })
    ).rejects.toThrow('control_activity_not_found')
  })

  it('serializes retained renewal against rollback without restoring aborted authority', async () => {
    const context = await setup()
    const { retention } = await retainedMigration(context)
    context.advance(5 * 60_000)
    const renewal = {
      activityId: context.activityId,
      cellId: cells[0]!.id,
      cellIncarnation: incarnations[0],
      retention,
      expiresAt: context.now() + 105_000
    }
    await context.store.renewControlActivity(identity, renewal)
    await context.store.recordCellHeartbeat({
      cellId: cells[0]!.id,
      cellUrl: cells[0]!.url,
      cellIncarnation: incarnations[0]!,
      startedAt: 99_999_000,
      ready: true,
      observedRequests: 1
    })
    await context.store.refreshRegionalRehomeLeases()
    const [renewed, aborted] = await Promise.allSettled([
      context.store.renewControlActivity(identity, renewal),
      context.store.abortExpiredEvacuations()
    ])
    expect(aborted).toEqual({ status: 'fulfilled', value: 1 })
    if (renewed.status === 'rejected')
      expect(String(renewed.reason)).toContain('activity_cell_not_authoritative')
    await expect(context.store.renewControlActivity(identity, renewal)).rejects.toThrow(
      'activity_cell_not_authoritative'
    )
    expect(
      await context.store.regionalRetentionRollback(identity, {
        ...renewal,
        cellIncarnation: incarnations[0]!
      })
    ).toMatchObject({ sourceGeneration: 7, assignmentEpoch: 3 })
  })

  it('advances the refresh page past an orphaned older attempt', async () => {
    const context = await setup()
    const { retention } = await retainedMigration(context)
    await context.database.query(
      `INSERT INTO relay_region_rehome_attempts
       (attempt_id,user_id,relay_host_id,preferred_region,source_cell_id,source_cell_incarnation,
        target_cell_id,target_cell_incarnation,previous_epoch,assignment_epoch,drain_grace_ms,send_attempts,created_at,updated_at)
       SELECT '44444444-4444-4444-8444-444444444444',user_id,'orphanhost000000',preferred_region,
         source_cell_id,source_cell_incarnation,target_cell_id,target_cell_incarnation,
         previous_epoch,assignment_epoch,drain_grace_ms,send_attempts,created_at - 1,updated_at - 1
       FROM relay_region_rehome_attempts WHERE attempt_id = ?`,
      [retention.attemptId]
    )
    context.advance(1)
    expect(await context.store.refreshRegionalRehomeLeases(1)).toBe(0)
    context.advance(1)
    expect(await context.store.refreshRegionalRehomeLeases(1)).toBe(1)
  })

  it('renews restored authority beyond the first short grant without authorizing the aborted retention', async () => {
    const context = await setup()
    const { retention } = await retainedMigration(context)
    context.advance(5 * 60_000)
    const base = {
      activityId: context.activityId,
      cellId: cells[0]!.id,
      cellIncarnation: incarnations[0]!
    }
    await context.store.renewControlActivity(identity, {
      ...base,
      retention,
      expiresAt: context.now() + 105_000
    })
    await context.store.recordCellHeartbeat({
      cellId: cells[0]!.id,
      cellUrl: cells[0]!.url,
      cellIncarnation: incarnations[0]!,
      startedAt: 99_999_000,
      ready: true,
      observedRequests: 1
    })
    await context.store.refreshRegionalRehomeLeases()
    expect(await context.store.abortExpiredEvacuations()).toBe(1)
    const restoration = (await context.store.regionalRetentionRollback(identity, {
      ...base,
      retention,
      expiresAt: context.now() + 105_000
    }))!
    expect(restoration).toMatchObject({ assignmentEpoch: 3, sourceGeneration: 7 })
    for (let round = 0; round < 10; round++) {
      context.advance(30_000)
      await context.store.renewControlActivity(identity, {
        ...base,
        restoration,
        expiresAt: context.now() + 105_000
      })
    }
    const lease = (
      await context.database.query(
        `SELECT expires_at FROM relay_assignment_activity_leases WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
        [identity.userId, identity.relayHostId, context.activityId]
      )
    )[0]!
    expect(Number(lease.expires_at)).toBe(context.now() + 105_000)
    await expect(
      context.store.renewControlActivity(identity, {
        ...base,
        retention,
        expiresAt: context.now() + 105_000
      })
    ).rejects.toThrow('activity_cell_not_authoritative')
    await expect(
      context.store.renewControlActivity(identity, {
        ...base,
        restoration: { ...restoration, assignmentEpoch: 4 },
        expiresAt: context.now() + 105_000
      })
    ).rejects.toThrow('activity_cell_not_authoritative')
    await expect(
      context.store.renewControlActivity(identity, {
        ...base,
        restoration: { ...restoration, sourceGeneration: 8 },
        expiresAt: context.now() + 105_000
      })
    ).rejects.toThrow('activity_cell_not_authoritative')
    await context.database.query(
      `UPDATE relay_control_capabilities SET finish_existing = 0 WHERE user_id = ?`,
      [identity.userId]
    )
    await expect(
      context.store.renewControlActivity(identity, {
        ...base,
        restoration,
        expiresAt: context.now() + 105_000
      })
    ).rejects.toThrow('activity_cell_not_authoritative')
  })

  it('rolls back an unregistered target and regrants only the same retained source', async () => {
    const context = await setup()
    const { retention, migration } = await retainedMigration(context)
    context.advance(5 * 60_000)
    await context.store.renewControlActivity(identity, {
      activityId: context.activityId,
      cellId: cells[0]!.id,
      cellIncarnation: incarnations[0],
      expiresAt: context.now() + 105_000,
      retention
    })
    await context.store.recordCellHeartbeat({
      cellId: cells[0]!.id,
      cellUrl: cells[0]!.url,
      cellIncarnation: incarnations[0]!,
      startedAt: 99_999_000,
      ready: true,
      observedRequests: 1
    })
    await context.store.refreshRegionalRehomeLeases()
    expect(await context.store.abortExpiredEvacuations()).toBe(1)
    const input = {
      cellId: cells[0]!.id,
      cellIncarnation: incarnations[0]!,
      activityId: context.activityId,
      retention,
      expiresAt: context.now() + 105_000
    }
    await expect(context.store.renewControlActivity(identity, input)).rejects.toThrow(
      'activity_cell_not_authoritative'
    )
    expect(await context.store.regionalRetentionRollback(identity, input)).toEqual({
      attemptId: retention.attemptId,
      sourceGeneration: retention.sourceGeneration,
      sourceAssignmentEpoch: retention.sourceAssignmentEpoch,
      assignmentEpoch: migration.assignmentEpoch + 1
    })
    expect(
      await context.store.regionalRetentionRollback(identity, {
        ...input,
        activityId: 'control:missing:7'
      })
    ).toBeNull()
  })
})
