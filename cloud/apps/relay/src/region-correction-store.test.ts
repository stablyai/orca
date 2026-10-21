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
    idleRegionalRehome: true
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

async function regionalMigration(context: Awaited<ReturnType<typeof setup>>) {
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
  return { migration }
}

describe('ordered region decisions and migration outcomes', () => {
  it('reports aggregate migration lifecycle and reservations without identity disclosure or writes', async () => {
    const context = await setup()
    const { migration } = await regionalMigration(context)
    context.advance(1_000)
    const before = await context.database.query('SELECT * FROM relay_region_rehome_attempts')
    const outcomes = await context.store.regionCorrectionOutcomes()
    expect(outcomes).toEqual([
      expect.objectContaining({
        sourceCellId: cells[0]!.id,
        targetCellId: cells[1]!.id,
        state: 'registering',
        count: 1,
        oldestOpenMs: 1_000
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
})
