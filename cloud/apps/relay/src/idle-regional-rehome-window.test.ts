import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayDatabase } from './database.js'
import { IDLE_REHOME_DECISION_WINDOW } from './idle-regional-rehome-selection.js'
import { openIdleRehomeTestDatabase } from './idle-regional-rehome-test-database.js'

// One source cell and three targets, so a poll has to rank targets per host
// rather than take the single one the two-cell fixture leaves it.
const cells = [
  { id: 'us', url: 'https://us.example.test', region: 'us-central1' as const, capacityRequests: 100 },
  { id: 'asia-busy', url: 'https://asia-busy.example.test', region: 'asia-east2' as const, capacityRequests: 100 },
  { id: 'asia-idle', url: 'https://asia-idle.example.test', region: 'asia-east2' as const, capacityRequests: 100 },
  { id: 'asia-mid', url: 'https://asia-mid.example.test', region: 'asia-east2' as const, capacityRequests: 100 }
]
const incarnations = cells.map((_, index) => `${index + 1}${'1'.repeat(7)}-1111-4111-8111-111111111111`)
const observed = [0, 60, 10, 30]

const databases: RelayDatabase[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) await database.close()
})

async function setup() {
  const database = await openIdleRehomeTestDatabase()
  databases.push(database)
  let now = 100_000_000
  const store = new RelayAssignmentStore(database, () => now, { regionalRehomeCohortPercent: 100 })
  await store.inspectRegionalRehomeControl()
  now += 86_400_000
  await store.applyRegionalRehomeControl({
    expectedGeneration: 0,
    enabled: true,
    notBefore: now,
    ratePerMinute: 10,
    preferenceMaxAgeMs: 86_400_000,
    hostCooldownMs: 604_800_000,
    drainGraceMs: 60_000
  })
  await store.reconcileCells(cells)
  const safety = {
    observedAt: now,
    sqlFailures: 0,
    reconnects: 0,
    controlActivityRecoveryFailures: 0,
    databasePoolWaiting: 0,
    databasePoolWaitersMax: 0,
    databasePoolWaitMsMax: 0
  }
  for (const [index, cell] of cells.entries()) {
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      region: cell.region,
      cellIncarnation: incarnations[index]!,
      startedAt: now - 1_000,
      ready: true,
      observedRequests: observed[index]!
    })
    await store.recordCellRegionalRehomeStatus({
      cellId: cell.id,
      cellIncarnation: incarnations[index]!,
      regionalRehomeProtocol: 3,
      safety
    })
  }
  return { store, database, safety, now }
}

async function seedHost(
  store: RelayAssignmentStore,
  identity: { userId: string; relayHostId: string }
): Promise<void> {
  const assignment = await store.assign(identity, undefined, 'us-central1')
  await store.activateControl(identity, {
    cellId: 'us',
    assignmentEpoch: assignment.assignmentEpoch,
    generation: 7,
    cellIncarnation: incarnations[0],
    idleRegionalRehome: true
  })
  const issued = await store.exchangeRegionCorrection(identity, { v: 1, action: 'issue-window' }, assignment.assignmentEpoch)
  await store.exchangeRegionCorrection(
    identity,
    {
      v: 1,
      action: 'report',
      generation: issued.window!.generation,
      assignmentEpoch: assignment.assignmentEpoch,
      policyVersion: 1,
      outcome: 'conclusive',
      measurements: { 'us-central1': 180, 'asia-east2': 40 }
    },
    assignment.assignmentEpoch
  )
}

// Clone one seeded host's rows under new identities, which is far cheaper than
// driving the full activation path thousands of times.
async function cloneHosts(
  database: RelayDatabase,
  template: { userId: string; relayHostId: string },
  count: number
): Promise<void> {
  for (const table of [
    'relay_assignments',
    'relay_assignment_activity_leases',
    'relay_control_capabilities',
    'relay_region_decisions'
  ]) {
    const row = (
      await database.query(`SELECT * FROM ${table} WHERE user_id = ? AND relay_host_id = ?`, [
        template.userId,
        template.relayHostId
      ])
    )[0]!
    const columns = Object.keys(row)
    const projection = columns.map((column) =>
      column === 'user_id' || column === 'relay_host_id' ? '?' : column
    )
    for (let index = 0; index < count; index++) {
      await database.query(
        `INSERT INTO ${table} (${columns.join(', ')}) SELECT ${projection.join(', ')} FROM ${table}
         WHERE user_id = ? AND relay_host_id = ?`,
        [
          `clone-${String(index).padStart(5, '0')}`,
          `clonehost${String(index).padStart(7, '0')}`,
          template.userId,
          template.relayHostId
        ]
      )
    }
  }
}

describe('idle regional rehome candidate window', () => {
  const identity = { userId: 'window-test', relayHostId: 'abcdefghijklmnop' }

  it('offers every eligible target for a host, least loaded first', async () => {
    const { store, safety } = await setup()
    await seedHost(store, identity)
    const candidates = await store.selectIdleRegionalRehomeCandidates(safety)
    expect(candidates.map((candidate) => candidate.targetCellId)).toEqual([
      'asia-idle',
      'asia-mid',
      'asia-busy'
    ])
    expect(new Set(candidates.map((candidate) => candidate.sourceCellUrl))).toEqual(
      new Set(['https://us.example.test'])
    )
    // Every candidate is the same move to a different target, so the attempt ids differ.
    expect(new Set(candidates.map((candidate) => candidate.attemptId)).size).toBe(3)
  })

  it('drops only the targets without room for the host plus its source activity', async () => {
    const { store, database, safety } = await setup()
    await seedHost(store, identity)
    await database.query(
      'UPDATE relay_assignment_activity_leases SET request_units = 4 WHERE user_id = ?',
      [identity.userId]
    )
    // Five units needed: four source units plus the assignment the move reserves.
    await database.query("UPDATE relay_cells SET capacity_requests = 4 WHERE cell_id = 'asia-idle'")
    const short = await store.selectIdleRegionalRehomeCandidates(safety)
    expect(short.map((candidate) => candidate.targetCellId)).toEqual(['asia-mid', 'asia-busy'])
    // Exactly enough room is enough; it ranks last because the ratio is per capacity.
    await database.query("UPDATE relay_cells SET capacity_requests = 5 WHERE cell_id = 'asia-idle'")
    const exact = await store.selectIdleRegionalRehomeCandidates(safety)
    expect(exact.map((candidate) => candidate.targetCellId)).toEqual([
      'asia-mid',
      'asia-busy',
      'asia-idle'
    ])
  })

  it('reads a bounded window of decisions however many hosts are eligible', async () => {
    const { store, database, safety } = await setup()
    await seedHost(store, identity)
    await cloneHosts(database, identity, IDLE_REHOME_DECISION_WINDOW + 200)
    const query = vi.spyOn(database, 'query')
    await store.selectIdleRegionalRehomeCandidates(safety)
    const calls = query.mock.calls.map((call) => call[0])
    const window = calls.findIndex((sql) => /FROM relay_region_decisions\s*$/m.test(sql))
    expect(window).toBeGreaterThanOrEqual(0)
    expect(query.mock.calls[window]![1]!.at(-1)).toBe(IDLE_REHOME_DECISION_WINDOW)
    // No statement pages by OFFSET any more: that was the cost that grew with the rollout.
    expect(calls.some((sql) => /OFFSET/i.test(sql))).toBe(false)
  })

  it('keeps the window\'s last host when a decision turns eligible between the two reads', async () => {
    const { store, database, safety, now } = await setup()
    await seedHost(store, identity)
    // Exactly one full window, whose last key in sort order is the seeded host.
    await cloneHosts(database, identity, IDLE_REHOME_DECISION_WINDOW - 1)
    await database.query(
      "UPDATE relay_assignment_activity_leases SET expires_at = ? WHERE user_id LIKE 'clone-%'",
      [now - 1]
    )
    const template = (
      await database.query('SELECT * FROM relay_region_decisions WHERE user_id = ?', [
        identity.userId
      ])
    )[0]!
    const columns = Object.keys(template)
    const query = database.query.bind(database)
    let inserted = false
    vi.spyOn(database, 'query').mockImplementation(async (sql, params) => {
      const rows = await query(sql, params)
      // A decision that becomes eligible after the window is read and sorts
      // inside it: a second LIMIT would push the window's last host out.
      if (!inserted && /^SELECT user_id, relay_host_id FROM relay_region_decisions/.test(sql)) {
        inserted = true
        await query(
          `INSERT INTO relay_region_decisions (${columns.join(', ')})
           VALUES (${columns.map(() => '?').join(', ')})`,
          columns.map((column) =>
            column === 'user_id'
              ? 'clone-99999'
              : column === 'relay_host_id'
                ? 'latehost99999999'
                : template[column]
          )
        )
      }
      return rows
    })
    const candidates = await store.selectIdleRegionalRehomeCandidates(safety)
    expect(candidates.map((candidate) => candidate.userId)).toEqual([
      identity.userId,
      identity.userId,
      identity.userId
    ])
  })

  it('walks the whole population in bounded pages and wraps only at the end', async () => {
    const { store, database, safety } = await setup()
    await seedHost(store, identity)
    await cloneHosts(database, identity, 120)
    const seen = new Set<string>()
    let pages = 0
    let wrapped = false
    // 121 hosts x 3 targets is 363 candidates, so the page cap has to be hit
    // several times before the window runs out and the cursor wraps.
    for (let poll = 0; poll < 20 && !wrapped; poll++) {
      const page = await store.selectIdleRegionalRehomeCandidates(safety)
      pages += 1
      const before = seen.size
      for (const candidate of page) seen.add(`${candidate.userId}/${candidate.targetCellId}`)
      if (seen.size === before && page.length > 0) wrapped = true
      if (page.length < 3) wrapped = true
    }
    expect(pages).toBeGreaterThan(1)
    expect(seen.size).toBe(121 * 3)
  })

  it('does not stall on a host the window found but the join rejected', async () => {
    const { store, database, safety, now } = await setup()
    await seedHost(store, identity)
    await cloneHosts(database, identity, 2)
    // The first host in key order loses its control lease, so it can never be a
    // candidate; an emitted-rows cursor would sit on it forever.
    await database.query('UPDATE relay_assignment_activity_leases SET expires_at = ? WHERE user_id = ?', [
      now - 1,
      'clone-00000'
    ])
    const first = await store.selectIdleRegionalRehomeCandidates(safety)
    expect(first.map((candidate) => candidate.userId)).not.toContain('clone-00000')
    expect(new Set(first.map((candidate) => candidate.userId))).toEqual(
      new Set(['clone-00001', identity.userId])
    )
  })

  it('excludes a host inside its rehome cooldown and takes it back after', async () => {
    const { store, database, safety, now } = await setup()
    await seedHost(store, identity)
    await database.query(
      `INSERT INTO relay_region_rehome_attempts
       (attempt_id, user_id, relay_host_id, preferred_region, source_cell_id, source_cell_incarnation,
        target_cell_id, target_cell_incarnation, previous_epoch, assignment_epoch, drain_grace_ms,
        send_attempts, created_at, updated_at)
       VALUES ('cooled', ?, ?, 'asia-east2', 'us', ?, 'asia-idle', ?, 0, 9, 0, 0, ?, ?)`,
      [identity.userId, identity.relayHostId, incarnations[0], incarnations[2], now - 1_000, now]
    )
    expect(await store.selectIdleRegionalRehomeCandidates(safety)).toEqual([])
    await database.query('UPDATE relay_region_rehome_attempts SET created_at = ?', [
      now - 604_800_000 - 1
    ])
    expect(await store.selectIdleRegionalRehomeCandidates(safety)).toHaveLength(3)
  })

  it('excludes a host outside the cohort', async () => {
    const { store, database } = await setup()
    await seedHost(store, identity)
    const now = 100_000_000 + 86_400_000
    const safety = {
      observedAt: now,
      sqlFailures: 0,
      reconnects: 0,
      controlActivityRecoveryFailures: 0,
      databasePoolWaiting: 0,
      databasePoolWaitersMax: 0,
      databasePoolWaitMsMax: 0
    }
    await database.query('UPDATE relay_region_decisions SET cohort_bucket = 40')
    const narrow = new RelayAssignmentStore(database, () => now, { regionalRehomeCohortPercent: 40 })
    expect(await narrow.selectIdleRegionalRehomeCandidates(safety)).toEqual([])
    const wide = new RelayAssignmentStore(database, () => now, { regionalRehomeCohortPercent: 41 })
    expect(await wide.selectIdleRegionalRehomeCandidates(safety)).toHaveLength(3)
  })
})
