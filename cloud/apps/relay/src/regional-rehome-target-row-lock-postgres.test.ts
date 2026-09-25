import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import {
  consumeRelayCellInventoryHold,
  openRelayDatabase,
  PostgresDatabase,
  type RelayDatabase
} from './database.js'
import { readRegionCorrectionOutcomes } from './region-correction-outcomes.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

// Roughly the round trip from an Asia cell to the us-central1 database.
const STATEMENT_DELAY_MS = 150

// Everything the fleet-wide rehome lock used to hold, per cell, plus the
// admission and region tables the commit reads.
const CELL_TABLES = [
  'relay_cells',
  'relay_cell_runtime',
  'relay_cell_capabilities',
  'relay_cell_rehome_safety',
  'relay_cell_admission',
  'relay_cell_regions'
] as const

// The target-row statement locks exactly these, held from it to COMMIT.
const TARGET_LOCKED = ['target:relay_cells', 'target:relay_cell_admission']

type Trip = { sql: string; lockable: Record<string, boolean> }

type DelayControl = {
  enabled: boolean
  // Runs before each delayed statement leaves the client, so it sees the locks
  // the transaction holds between round trips.
  beforeTrip: (sql: string) => Promise<void>
}

describePostgres('PostgreSQL regional rehome target-row lock', () => {
  let primary: RelayDatabase
  let observer: RelayDatabase
  let delayed: PostgresDatabase
  const control: DelayControl = { enabled: false, beforeTrip: async () => undefined }
  let sequence = 0

  beforeAll(async () => {
    primary = await openRelayDatabase({ databaseUrl, dataDir: '' })
    observer = await openRelayDatabase({ databaseUrl, dataDir: '' })
    delayed = openDelayedDatabase(databaseUrl!, control)
  })

  beforeEach(async () => {
    control.enabled = false
    control.beforeTrip = async () => undefined
    await cleanup()
  })

  afterAll(async () => {
    control.enabled = false
    await cleanup()
    await delayed.close()
    await observer.close()
    await primary.close()
  })

  async function cleanup(): Promise<void> {
    for (const table of [
      'relay_region_decisions',
      'relay_control_capabilities',
      'relay_region_rehome_attempts',
      'relay_control_connection_reservations',
      'relay_assignment_migration_incarnations',
      'relay_assignment_activity_leases',
      'relay_assignment_migrations',
      'relay_assignment_region_preferences',
      'relay_assignments'
    ]) {
      await primary.query(`DELETE FROM ${table} WHERE user_id LIKE 'pg-lock-user-%'`)
    }
    await primary.query(`DELETE FROM relay_region_rehome_worker_state`)
    await primary.query(`DELETE FROM relay_region_rehome_control`)
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
      await primary.query(`DELETE FROM ${table} WHERE cell_id LIKE 'pg-lock-cell-%'`)
    }
  }

  async function lockable(table: string, cellId: string): Promise<boolean> {
    try {
      await observer.transaction(
        async (transaction) => {
          await transaction.queryLocked(`SELECT cell_id FROM ${table} WHERE cell_id = ?`, [cellId], {
            failIfUnavailable: true
          })
        },
        { reportRetries: false }
      )
      return true
    } catch (error) {
      if (error instanceof Error && error.message === 'database_lock_unavailable') return false
      throw error
    }
  }

  async function reservedRequests(cellId: string): Promise<number> {
    const row = (
      await primary.query(`SELECT reserved_requests FROM relay_cells WHERE cell_id = ?`, [cellId])
    )[0]!
    return Number(row.reserved_requests)
  }

  async function commitCounts(userId: string): Promise<{ attempts: number; migrations: number }> {
    const attempts = await primary.query(
      `SELECT COUNT(*) AS count FROM relay_region_rehome_attempts WHERE user_id = ?`,
      [userId]
    )
    const migrations = await primary.query(
      `SELECT COUNT(*) AS count FROM relay_assignment_migrations WHERE user_id = ?`,
      [userId]
    )
    return { attempts: Number(attempts[0]!.count), migrations: Number(migrations[0]!.count) }
  }

  // Mirrors the admission selector's write: every cell row locked, then the
  // admission row and the cell's enabled flag rewritten.
  async function flipAdmission(transaction: RelayDatabase, cellId: string, now: number) {
    await transaction.queryLocked(`SELECT cell_id FROM relay_cells ORDER BY cell_id ASC`)
    await transaction.query(
      `UPDATE relay_cell_admission SET admission_state = 'migration-only', updated_at = ?
       WHERE cell_id = ?`,
      [now, cellId]
    )
    await transaction.query(`UPDATE relay_cells SET enabled = 1, updated_at = ? WHERE cell_id = ?`, [
      now,
      cellId
    ])
  }

  it('holds only the target row, for about one round trip, while other cells stay lockable', async () => {
    const context = await fixture()
    const request = await context.select()
    const trips: Trip[] = []
    const probed = {
      source: context.source.id,
      target: context.target.id,
      bystander: context.bystander.id
    }
    control.beforeTrip = async (sql) => {
      const state: Record<string, boolean> = {}
      for (const [role, cellId] of Object.entries(probed)) {
        for (const table of CELL_TABLES) state[`${role}:${table}`] = await lockable(table, cellId)
      }
      trips.push({ sql, lockable: state })
    }
    consumeRelayCellInventoryHold(delayed)
    control.enabled = true

    const result = await context.delayedStore.commitIdleRegionalRehome(request, context.safety())
    control.enabled = false

    expect(result).toEqual({ outcome: 'committed' })
    // The transaction really spans many cross-region round trips.
    expect(trips.length).toBeGreaterThanOrEqual(15)
    expect(trips[trips.length - 1]!.sql).toBe('COMMIT')
    for (const trip of trips) {
      for (const [key, free] of Object.entries(trip.lockable)) {
        if (TARGET_LOCKED.includes(key)) continue
        expect({ sql: trip.sql, key, free }).toEqual({ sql: trip.sql, key, free: true })
      }
    }
    // Locked at exactly one trip boundary, the one before COMMIT.
    for (const key of TARGET_LOCKED) {
      expect(trips.filter((trip) => !trip.lockable[key]).map((trip) => trip.sql)).toEqual([
        'COMMIT'
      ])
    }
    const counts = consumeRelayCellInventoryHold(delayed)
    console.info(
      JSON.stringify({ event: 'rehome_target_row_hold', trips: trips.length, ...counts })
    )
    expect(counts.rehomeTargetRowHolds).toBe(1)
    expect(counts.cellInventoryHoldMaxSite).toBe('rehome-target-row')
    expect(counts.rehomeTargetRowHoldMsMax).toBeGreaterThanOrEqual(STATEMENT_DELAY_MS)
    expect(counts.rehomeTargetRowHoldMsMax).toBeLessThanOrEqual(2 * STATEMENT_DELAY_MS)
    expect(await reservedRequests(context.target.id)).toBe(context.targetReservedBefore + 2)
  })

  it('defers when the target leaves general admission after selection', async () => {
    const context = await fixture()
    const request = await context.select()
    control.beforeTrip = async (sql) => {
      if (!sql.includes('WITH target AS')) return
      await observer.transaction(
        async (transaction) => await flipAdmission(transaction, context.target.id, context.now())
      )
    }
    control.enabled = true

    const result = await context.delayedStore.commitIdleRegionalRehome(request, context.safety())
    control.enabled = false

    expect(result).toEqual({ outcome: 'deferred', reason: 'candidate-ineligible' })
    await expectNothingCommitted(context)
  })

  it('defers instead of waiting while an admission change holds the target row', async () => {
    const context = await fixture()
    const request = await context.select()
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let writer: Promise<void> | undefined
    control.beforeTrip = async (sql) => {
      if (!sql.includes('WITH target AS') || writer) return
      let locked!: () => void
      const lockedPromise = new Promise<void>((resolve) => (locked = resolve))
      writer = observer.transaction(async (transaction) => {
        await flipAdmission(transaction, context.target.id, context.now())
        locked()
        await released
      })
      await lockedPromise
    }
    consumeRelayCellInventoryHold(delayed)
    control.enabled = true

    const startedAt = performance.now()
    const result = await context.delayedStore.commitIdleRegionalRehome(request, context.safety())
    const elapsedMs = performance.now() - startedAt
    control.enabled = false
    release()
    await writer

    expect(result).toEqual({ outcome: 'deferred', reason: 'candidate-ineligible' })
    expect(consumeRelayCellInventoryHold(delayed)).toMatchObject({
      cellInventoryLockUnavailable: 1,
      rehomeTargetRowHolds: 0
    })
    // NOWAIT: no 1s lock_timeout wait and no transaction retry behind the writer.
    expect(elapsedMs).toBeLessThan(40 * STATEMENT_DELAY_MS)
    await expectNothingCommitted(context)
  })

  async function expectNothingCommitted(context: Awaited<ReturnType<typeof fixture>>) {
    expect(await commitCounts(context.identity.userId)).toEqual({ attempts: 0, migrations: 0 })
    expect(await reservedRequests(context.target.id)).toBe(context.targetReservedBefore)
    expect(
      await primary.query(`SELECT cell_id FROM relay_assignments WHERE user_id = ?`, [
        context.identity.userId
      ])
    ).toEqual([{ cell_id: context.source.id }])
    const outcomes = await readRegionCorrectionOutcomes(primary, context.now())
    expect(outcomes.filter((outcome) => outcome.targetCellId === context.target.id)).toEqual([])
  }

  async function fixture() {
    sequence++
    let now = 1_000_000
    const suffix = String(sequence)
    // An Asia source correcting to a US target: the direction whose commit
    // held the whole inventory for ~3.6s in production.
    const source = cell(suffix, 'source', 'asia-east2')
    const target = cell(suffix, 'target', 'us-central1')
    const bystander = cell(suffix, 'zbystander', 'asia-east2')
    const store = new RelayAssignmentStore(primary, () => now, storeOptions)
    const delayedStore = new RelayAssignmentStore(delayed, () => now, storeOptions)
    await store.inspectRegionalRehomeControl()
    now += 24 * 60 * 60_000
    await store.applyRegionalRehomeControl({
      expectedGeneration: 0,
      enabled: true,
      notBefore: now,
      ratePerMinute: 10,
      preferenceMaxAgeMs: 24 * 60 * 60_000,
      hostCooldownMs: 7 * 24 * 60 * 60_000,
      drainGraceMs: 60_000
    })
    await store.reconcileCells([source, target])
    await heartbeat(store, source, '11111111-1111-4111-8111-111111111111', now)
    await heartbeat(store, target, '22222222-2222-4222-8222-222222222222', now)
    const identity = {
      userId: `pg-lock-user-${suffix}`,
      relayHostId: `lockhost${suffix.padStart(8, '0')}`
    }
    const assignment = await store.assign(identity, undefined, 'asia-east2')
    // Added after placement so the host cannot land on it.
    await store.reconcileCells([source, target, bystander])
    await heartbeat(store, bystander, '33333333-3333-4333-8333-333333333333', now)
    await store.activateControl(identity, {
      cellId: source.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1,
      idleRegionalRehome: true,
      cellIncarnation: '11111111-1111-4111-8111-111111111111'
    })
    await store.assign(identity, 'us-central1')
    const issued = await store.exchangeRegionCorrection(
      identity,
      { v: 1, action: 'issue-window' },
      assignment.assignmentEpoch
    )
    await store.exchangeRegionCorrection(
      identity,
      {
        v: 1,
        action: 'report',
        generation: issued.window!.generation,
        assignmentEpoch: assignment.assignmentEpoch,
        policyVersion: 1,
        outcome: 'conclusive',
        measurements: { 'us-central1': 50, 'asia-east2': 150 }
      },
      assignment.assignmentEpoch
    )
    const safety = () => processSafety(now)
    return {
      store,
      delayedStore,
      identity,
      source,
      target,
      bystander,
      targetReservedBefore: await reservedRequests(target.id),
      now: () => now,
      safety,
      select: async () => {
        const [request] = await store.selectIdleRegionalRehomeCandidates(safety())
        expect(request).toMatchObject({ sourceCellId: source.id, targetCellId: target.id })
        return request!
      }
    }
  }
})

// Same session settings as the serving pool, with a fixed delay in front of
// every statement, BEGIN and COMMIT included.
function openDelayedDatabase(url: string, control: DelayControl): PostgresDatabase {
  const pool = new pg.Pool({
    connectionString: url,
    max: 4,
    statement_timeout: 5_000,
    lock_timeout: 1_000,
    idle_in_transaction_session_timeout: 5_000
  })
  pool.on('error', () => undefined)
  pool.on('connect', (client) => {
    const query = client.query
    Object.assign(client, {
      query: async (...args: unknown[]) => {
        if (control.enabled) {
          await control.beforeTrip(typeof args[0] === 'string' ? args[0] : '')
          await new Promise((resolve) => setTimeout(resolve, STATEMENT_DELAY_MS))
        }
        return await Reflect.apply(query, client, args)
      }
    })
  })
  return new PostgresDatabase(pool)
}

const storeOptions = {
  regionalRehomeCohortPercent: 100,
  requireLiveCells: true,
  heartbeatTtlMs: 45_000
}

function cell(suffix: string, role: string, region: 'us-central1' | 'asia-east2') {
  return {
    id: `pg-lock-cell-${suffix}-${role}`,
    url: `https://pg-lock-${suffix}-${role}.example.test`,
    region,
    capacityRequests: 100,
    connectionHardCap: 1_000 as const,
    connectionUnobservedBound: 60
  }
}

function processSafety(now: number) {
  return {
    observedAt: now,
    sqlFailures: 0,
    reconnects: 0,
    controlActivityRecoveryFailures: 0,
    databasePoolWaiting: 0,
    databasePoolWaitersMax: 0,
    databasePoolWaitMsMax: 0
  }
}

async function heartbeat(
  store: RelayAssignmentStore,
  cellConfig: ReturnType<typeof cell>,
  cellIncarnation: string,
  now: number
): Promise<void> {
  await store.recordCellHeartbeat({
    cellId: cellConfig.id,
    cellUrl: cellConfig.url,
    region: cellConfig.region,
    cellIncarnation,
    startedAt: 900_000,
    ready: true,
    observedRequests: 0,
    totalConnections: 0,
    inFlightConnections: 0,
    reservedConnectionUnits: 0,
    enforcedConnectionUnits: 0,
    connectionInclusionWatermark: 1,
    connectionHardCap: 1_000,
    connectionUnobservedBound: 60
  })
  await store.recordCellRegionalRehomeStatus({
    cellId: cellConfig.id,
    cellIncarnation,
    regionalRehomeProtocol: 3,
    safety: processSafety(now)
  })
}
