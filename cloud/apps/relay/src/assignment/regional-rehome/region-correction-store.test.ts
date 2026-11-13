import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from '../assignment-store.js'
import { openInMemoryRelayDatabase, openRelayDatabase, type RelayDatabase } from '../../database/database.js'

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

describe('ordered region decisions and migration outcomes', () => {
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

  it('rejects stale assignment basis and requires both thresholds', async () => {
    const context = await setup()
    for (const measurements of [
      { 'us-central1': 96, 'asia-east2': 72 },
      { 'us-central1': 200, 'asia-east2': 175 }
    ]) {
      const rejected = await window(context)
      await expect(
        context.store.exchangeRegionCorrection(
          identity,
          {
            v: 1,
            action: 'report',
            generation: rejected.generation,
            assignmentEpoch: rejected.assignmentEpoch,
            policyVersion: 1,
            outcome: 'conclusive',
            measurements
          },
          rejected.assignmentEpoch
        )
      ).resolves.toMatchObject({ reportStatus: 'accepted' })
      expect(await context.store.previewRegionCorrection()).toEqual({ ineligible: 1 })
    }
    const issued = await window(context)
    await expect(
      context.store.exchangeRegionCorrection(
        identity,
        {
          v: 1,
          action: 'report',
          generation: issued.generation,
          assignmentEpoch: issued.assignmentEpoch,
          policyVersion: 1,
          outcome: 'conclusive',
          measurements: { 'us-central1': 125, 'asia-east2': 100 }
        },
        issued.assignmentEpoch
      )
    ).resolves.toMatchObject({ reportStatus: 'accepted' })
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
