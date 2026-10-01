import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentRowBusyError, RelayAssignmentStore } from './assignment-store.js'
import {
  encodeMembership,
  type CellAdmissionMembership,
  type CellAdmissionState
} from './cell-admission-selector.js'
import type { RelayCellConfig } from './config.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const USER_PREFIX = 'isolated-replacement-postgres'
const NOW = 100
const CAPPED = {
  capacityRequests: 1_000,
  connectionHardCap: 600,
  connectionUnobservedBound: 50
} as const
const ISOLATED: RelayCellConfig = {
  id: 'isolated-replacement-source',
  url: 'https://isolated-replacement-source.example.com',
  region: 'us-central1',
  ...CAPPED
}
const TARGETS: RelayCellConfig[] = [
  {
    id: 'isolated-replacement-target-a',
    url: 'https://isolated-replacement-target-a.example.com',
    region: 'us-central1',
    ...CAPPED
  },
  {
    id: 'isolated-replacement-target-b',
    url: 'https://isolated-replacement-target-b.example.com',
    region: 'us-central1',
    ...CAPPED
  }
]
// The next tier: taken only when the source's region has no general room.
const OTHER_REGION: RelayCellConfig = {
  id: 'isolated-replacement-other-region',
  url: 'https://isolated-replacement-other-region.example.com',
  region: 'asia-east2',
  ...CAPPED
}
const CELLS = [ISOLATED, ...TARGETS, OTHER_REGION]
const HOST_COUNT = 50

function hostIdentity(index: number): { userId: string; relayHostId: string } {
  return {
    userId: `${USER_PREFIX}-${index}`,
    // relay host ids are fixed-width opaque ids.
    relayHostId: `isolatedhost${String(index).padStart(4, '0')}`
  }
}

describePostgres('PostgreSQL re-placement off a cell isolated for a roll', () => {
  const databases: RelayDatabase[] = []
  let stores: RelayAssignmentStore[] = []

  async function reservedRequests(cellId: string): Promise<number> {
    const rows = await databases[0]!.query(
      `SELECT reserved_requests FROM relay_cells WHERE cell_id = ?`,
      [cellId]
    )
    return Number(rows[0]!['reserved_requests'])
  }

  // The accounting invariant the migration paths assert: a cell's counter is
  // exactly the units of the leases held on it.
  async function expectReservationAccounting(): Promise<void> {
    for (const cell of CELLS) {
      const leased = await databases[0]!.query(
        `SELECT COALESCE(SUM(request_units), 0) AS units
         FROM relay_assignment_activity_leases WHERE cell_id = ?`,
        [cell.id]
      )
      expect({ cell: cell.id, reserved: await reservedRequests(cell.id) }).toEqual({
        cell: cell.id,
        reserved: Number(leased[0]!['units'])
      })
    }
  }

  async function expectReservationAccountingExcept(cellId: string): Promise<void> {
    for (const cell of CELLS.filter(({ id }) => id !== cellId)) {
      const leased = await databases[0]!.query(
        `SELECT COALESCE(SUM(request_units), 0) AS units
         FROM relay_assignment_activity_leases WHERE cell_id = ?`,
        [cell.id]
      )
      expect(await reservedRequests(cell.id)).toBe(Number(leased[0]!['units']))
    }
  }

  async function counters(identity: {
    userId: string
    relayHostId: string
  }): Promise<{ controls: number; splices: number }> {
    const rows = await databases[0]!.query(
      `SELECT reserved_controls, reserved_splices FROM relay_assignments
       WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    return {
      controls: Number(rows[0]!['reserved_controls']),
      splices: Number(rows[0]!['reserved_splices'])
    }
  }

  // Holds the named relay_cells rows in another session until released, the
  // way a release from a far cell holds its row across a round trip.
  async function holdCellRows(cellIds: string[]): Promise<() => Promise<void>> {
    return await holdRows(
      `SELECT cell_id FROM relay_cells WHERE cell_id IN (${cellIds.map(() => '?').join(', ')})
       ORDER BY cell_id ASC`,
      cellIds
    )
  }

  async function holdRows(sql: string, params: unknown[]): Promise<() => Promise<void>> {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let held!: () => void
    const acquired = new Promise<void>((resolve) => (held = resolve))
    const holder = databases[3]!.transaction(async (transaction) => {
      await transaction.queryLocked(sql, params)
      held()
      await released
    })
    await acquired
    return async () => {
      release()
      await holder
    }
  }

  // Puts a host on the source with a live control and a splice, then isolates
  // the source for a roll with both targets open.
  async function seedActiveHostOnIsolatedSource(index: number): Promise<{
    identity: { userId: string; relayHostId: string }
    first: { cellId: string; assignmentEpoch: number }
  }> {
    const identity = hostIdentity(index)
    await applySelector({ [TARGETS[0]!.id]: 'migration-only', [TARGETS[1]!.id]: 'migration-only' })
    const first = await stores[0]!.assign(identity, 'us-central1')
    expect(first.cellId).toBe(ISOLATED.id)
    await stores[0]!.activateControl(identity, {
      cellId: ISOLATED.id,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await stores[0]!.acquireActivity(identity, {
      activityId: 'splice:keep-1',
      kind: 'splice',
      cellId: ISOLATED.id
    })
    await applySelector({ [TARGETS[0]!.id]: 'general', [TARGETS[1]!.id]: 'general' })
    await applySelector({ [ISOLATED.id]: 'migration-only' }, [ISOLATED.id])
    return { identity, first }
  }

  // `enforced` puts a cell at its connection cap, which leaves it no headroom.
  async function heartbeatAll(enforced: Record<string, number> = {}): Promise<void> {
    for (const [index, cell] of CELLS.entries()) {
      await stores[0]!.recordCellHeartbeat({
        cellId: cell.id,
        cellUrl: cell.url,
        cellIncarnation: `1111111${index}-1111-4111-8111-111111111111`,
        startedAt: 50,
        ready: true,
        observedRequests: 0,
        region: cell.region,
        // The cell checks enforced = total + in-flight + reserved.
        totalConnections: enforced[cell.id] ?? 0,
        inFlightConnections: 0,
        reservedConnectionUnits: 0,
        enforcedConnectionUnits: enforced[cell.id] ?? 0,
        connectionHardCap: 600,
        connectionUnobservedBound: 50
      })
    }
  }

  // The real isolate path: one selector apply, generation CAS and all, naming
  // the cells it stamps. Nothing else in the fleet may write the stamp.
  async function applySelector(
    states: Record<string, CellAdmissionState>,
    rollIsolatedCells?: string[]
  ): Promise<void> {
    const current = await stores[0]!.inspectCellAdmissionSelector()
    // Built from relay_cells, not from the selector's own membership: the apply
    // requires exact coverage of the fleet, and this database is shared.
    const fleet = await databases[0]!.query(
      `SELECT cell_id FROM relay_cells ORDER BY cell_id ASC`
    )
    const membership: CellAdmissionMembership = {
      existingOnly: [],
      migrationOnly: [],
      general: []
    }
    for (const row of fleet) {
      const cellId = String(row['cell_id'])
      const state =
        states[cellId] ??
        (current.selector.membership.existingOnly.includes(cellId)
          ? 'existing-only'
          : current.selector.membership.migrationOnly.includes(cellId)
            ? 'migration-only'
            : 'general')
      if (state === 'existing-only') membership.existingOnly.push(cellId)
      else if (state === 'migration-only') membership.migrationOnly.push(cellId)
      else membership.general.push(cellId)
    }
    await stores[0]!.applyCellAdmissionSelector({
      // The id is capped at 128 characters; the generation already makes it unique.
      attemptId: `isolated-${current.selector.generation}-${createHash('sha256')
        .update(Object.keys(states).join('-'))
        .digest('hex')
        .slice(0, 16)}`,
      expectedGeneration: current.selector.generation,
      ...(current.selector.generation === 0
        ? {
            expectedMembershipSha256: createHash('sha256')
              .update(encodeMembership(current.selector.membership))
              .digest('hex')
          }
        : {}),
      membership,
      ...(rollIsolatedCells ? { rollIsolatedCells } : {})
    })
  }

  async function rollIsolatedAt(cellId: string): Promise<number | null> {
    const rows = await databases[0]!.query(
      `SELECT roll_isolated_at FROM relay_cell_admission WHERE cell_id = ?`,
      [cellId]
    )
    const value = rows[0]?.['roll_isolated_at']
    return value === undefined || value === null ? null : Number(value)
  }

  // Every case starts from the whole fleet general; a case that leaves a cell
  // isolated would otherwise starve the next one of placement candidates.
  async function resetFleet(): Promise<void> {
    await deleteHostRows()
    // Only this file's hosts hold leases on these cells, so zero is exact.
    await databases[0]!.query(
      `UPDATE relay_cells SET reserved_requests = 0
       WHERE cell_id IN (${CELLS.map(() => '?').join(', ')})`,
      CELLS.map((cell) => cell.id)
    )
    await applySelector(Object.fromEntries(CELLS.map((cell) => [cell.id, 'general'])))
  }

  // The selector is fleet-wide and this database is shared with every other
  // Postgres file in the project, all of which write admission through the
  // generation-0 helpers. Advancing the generation and leaving it advanced
  // would fail every one of them with admission_selector_boundary_active, so
  // this file puts the boundary back exactly as it found it.
  async function resetSelectorBoundary(): Promise<void> {
    await databases[0]!.query(
      `UPDATE relay_admission_selectors SET generation = 0, attempt_id = NULL
       WHERE selector_id = 'general'`
    )
    await databases[0]!.query(
      `DELETE FROM relay_admission_selector_intents WHERE attempt_id LIKE 'isolated-%'`
    )
    // Rewrites membership_json from the live fleet, which generation 0 allows.
    await stores[0]!.reconcileCells([], false)
  }

  async function deleteHostRows(): Promise<void> {
    for (const table of [
      'relay_control_connection_reservations',
      'relay_assignment_activity_leases',
      'relay_assignment_migrations',
      'relay_assignments'
    ]) {
      await databases[0]!.query(`DELETE FROM ${table} WHERE user_id LIKE '${USER_PREFIX}-%'`)
    }
  }

  beforeAll(async () => {
    // Four connections so the concurrent dials below really contend on the
    // fleet-wide relay_cells lock rather than queueing in one client.
    for (let index = 0; index < 4; index += 1) {
      databases.push(await openRelayDatabase({ databaseUrl, dataDir: '' }))
    }
    stores = databases.map(
      (database) =>
        new RelayAssignmentStore(database, () => NOW, {
          requireLiveCells: true,
          heartbeatTtlMs: 45_000
        })
    )
    await deleteHostRows()
    // Registers the cell rows without touching admission, so this works at any
    // selector generation the shared database happens to be sitting at.
    await stores[0]!.reconcileCells(CELLS, false)
    await resetSelectorBoundary()
    await heartbeatAll()
  })

  afterAll(async () => {
    if (databases[0]) {
      await deleteHostRows()
      // Order matters: drop the cells first, then rebuild the selector's
      // membership from what is left, or it names rows that no longer exist and
      // every later read fails admission_selector_membership_drift.
      for (const cell of CELLS) {
        for (const table of [
          'relay_cell_connection_snapshots',
          'relay_cell_connection_runtime',
          'relay_cell_connection_limits',
          'relay_cell_runtime',
          'relay_cell_admission',
          'relay_cell_regions',
          'relay_cells'
        ]) {
          await databases[0].query(`DELETE FROM ${table} WHERE cell_id = ?`, [cell.id])
        }
      }
      await resetSelectorBoundary()
    }
    for (const connection of databases) await connection.close()
  })

  it('stamps only the named cell on isolate and clears it on restore', async () => {
    await resetFleet()
    expect(await rollIsolatedAt(ISOLATED.id)).toBeNull()

    await applySelector({ [ISOLATED.id]: 'migration-only' }, [ISOLATED.id])
    const stamped = await rollIsolatedAt(ISOLATED.id)
    expect(stamped).toBe(NOW)
    // Cells the isolate did not name stay unmarked even when parked in the same
    // apply: that is every non-roll flow, and its hosts must keep their pin.
    await applySelector({ [TARGETS[0]!.id]: 'migration-only' })
    expect(await rollIsolatedAt(TARGETS[0]!.id)).toBeNull()

    // A failed wave re-isolates rather than restoring; the stamp survives, and
    // does not move, so the hosts left behind stay eligible.
    await applySelector({ [ISOLATED.id]: 'migration-only' }, [ISOLATED.id])
    expect(await rollIsolatedAt(ISOLATED.id)).toBe(stamped)

    // Restore writes 'general', and the same statement clears the stamp.
    await applySelector({ [ISOLATED.id]: 'general' })
    expect(await rollIsolatedAt(ISOLATED.id)).toBeNull()
  }, 30_000)

  it('ignores a stamp older than the roll it is supposed to describe', async () => {
    // A failed wave keeps its stamp on purpose and can sit for hours; past the
    // bound the cell stops shedding hosts one dial at a time.
    await resetFleet()
    const identity = hostIdentity(902)
    const first = await stores[0]!.assign(identity, 'us-central1')
    await applySelector({ [ISOLATED.id]: 'migration-only' }, [ISOLATED.id])
    await databases[0]!.query(
      `UPDATE relay_cell_admission SET roll_isolated_at = ? WHERE cell_id = ?`,
      [NOW - (2 * 60 * 60_000 + 1), ISOLATED.id]
    )

    expect(await stores[0]!.assign(identity, 'us-central1')).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })
  }, 30_000)

  it('re-places every host off an isolated cell without leaking a reservation', async () => {
    await resetFleet()
    const identities = Array.from({ length: HOST_COUNT }, (_, index) => hostIdentity(index))
    const sourceBaseline = await reservedRequests(ISOLATED.id)
    const targetBaseline =
      (await reservedRequests(TARGETS[0]!.id)) + (await reservedRequests(TARGETS[1]!.id))

    // Everyone lands on the cell about to be isolated.
    await applySelector({ [TARGETS[0]!.id]: 'migration-only', [TARGETS[1]!.id]: 'migration-only' })
    const first = new Map<string, { cellId: string; assignmentEpoch: number }>()
    for (const identity of identities) {
      const grant = await stores[0]!.assign(identity, 'us-central1')
      expect(grant.cellId).toBe(ISOLATED.id)
      first.set(identity.relayHostId, grant)
    }
    await applySelector({ [TARGETS[0]!.id]: 'general', [TARGETS[1]!.id]: 'general' })

    // The isolate step. The state and the stamp are written by one UPDATE under
    // the fleet-wide relay_cells lock, so there is no torn state to race against.
    await applySelector({ [ISOLATED.id]: 'migration-only' }, [ISOLATED.id])
    expect(await rollIsolatedAt(ISOLATED.id)).not.toBeNull()

    const grants = await Promise.all(
      identities.map(
        async (identity, index) =>
          await stores[1 + (index % (stores.length - 1))]!.assign(identity, 'us-central1')
      )
    )

    for (const [index, grant] of grants.entries()) {
      const identity = identities[index]!
      expect(grant.cellId).not.toBe(ISOLATED.id)
      expect(TARGETS.map(({ id }) => id)).toContain(grant.cellId)
      // Exactly once: a double bump would mean two transactions both moved it.
      expect(grant.assignmentEpoch).toBe(first.get(identity.relayHostId)!.assignmentEpoch + 1)
    }

    // The placement leaves the source row alone: each host's pending control
    // there still counts until the source releases it.
    expect(await reservedRequests(ISOLATED.id)).toBe(sourceBaseline + HOST_COUNT)
    expect(
      (await reservedRequests(TARGETS[0]!.id)) + (await reservedRequests(TARGETS[1]!.id))
    ).toBe(targetBaseline + HOST_COUNT)
    await expectReservationAccounting()
    for (const identity of identities) {
      expect(
        await stores[0]!.releaseActivity(
          identity,
          `control-pending:${first.get(identity.relayHostId)!.assignmentEpoch}`
        )
      ).toBe(true)
    }
    expect(await reservedRequests(ISOLATED.id)).toBe(sourceBaseline)
    await expectReservationAccounting()

    const rows = await databases[0]!.query(
      `SELECT COUNT(*) AS count FROM relay_assignments
       WHERE user_id LIKE '${USER_PREFIX}-%' AND cell_id = ?`,
      [ISOLATED.id]
    )
    expect(Number(rows[0]!['count'])).toBe(0)
  }, 60_000)

  it('lets exactly one of a host’s racing dials win the re-placement', async () => {
    await resetFleet()
    const identity = hostIdentity(900)
    await applySelector({ [TARGETS[0]!.id]: 'migration-only', [TARGETS[1]!.id]: 'migration-only' })
    const first = await stores[0]!.assign(identity, 'us-central1')
    expect(first.cellId).toBe(ISOLATED.id)
    await applySelector({ [TARGETS[0]!.id]: 'general', [TARGETS[1]!.id]: 'general' })
    const targetBaseline =
      (await reservedRequests(TARGETS[0]!.id)) + (await reservedRequests(TARGETS[1]!.id))
    const sourceBefore = await reservedRequests(ISOLATED.id)

    await applySelector({ [ISOLATED.id]: 'migration-only' }, [ISOLATED.id])

    // Two dials from the same host, on separate connections, through the same
    // sticky lane. The per-assignment row lock is what must serialise them.
    const raced = await Promise.allSettled([
      stores[1]!.assign(identity, 'us-central1'),
      stores[2]!.assign(identity, 'us-central1')
    ])
    const granted = raced.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    expect(granted.length).toBeGreaterThan(0)

    // However many dials were granted, only one re-placement may have
    // committed: the epoch advances by exactly one and the target gains exactly
    // one unit. The source keeps its lease until the source releases it.
    const settled = await stores[0]!.resolve(identity)
    expect(settled?.assignmentEpoch).toBe(first.assignmentEpoch + 1)
    expect(settled?.cellId).not.toBe(ISOLATED.id)
    for (const grant of granted) expect(grant.cellId).toBe(settled?.cellId)
    expect(await reservedRequests(ISOLATED.id)).toBe(sourceBefore)
    expect(
      (await reservedRequests(TARGETS[0]!.id)) + (await reservedRequests(TARGETS[1]!.id))
    ).toBe(targetBaseline + 1)
  }, 30_000)

  it('grants no host the isolated cell after the admission flip commits', async () => {
    await resetFleet()
    const identity = hostIdentity(901)
    const first = await stores[0]!.assign(identity, 'us-central1')
    await applySelector({ [ISOLATED.id]: 'migration-only' }, [ISOLATED.id])

    for (let dial = 0; dial < 5; dial += 1) {
      const grant = await stores[1 + (dial % (stores.length - 1))]!.assign(
        identity,
        'us-central1'
      )
      expect(grant.cellId).not.toBe(ISOLATED.id)
    }
    // Only the first dial re-places; the rest are ordinary sticky re-grants.
    expect((await stores[0]!.resolve(identity))?.assignmentEpoch).toBe(
      first.assignmentEpoch + 1
    )
  }, 30_000)
  it('leaves the source row to the source’s own releases and keeps the host’s counters', async () => {
    await resetFleet()
    const { identity, first } = await seedActiveHostOnIsolatedSource(910)
    const sourceBefore = await reservedRequests(ISOLATED.id)
    const targetsBefore =
      (await reservedRequests(TARGETS[0]!.id)) + (await reservedRequests(TARGETS[1]!.id))
    expect(sourceBefore).toBe(3)
    expect(await counters(identity)).toEqual({ controls: 1, splices: 1 })

    const moved = await stores[1]!.assign(identity, 'us-central1')
    expect(TARGETS.map(({ id }) => id)).toContain(moved.cellId)
    expect(moved.assignmentEpoch).toBe(first.assignmentEpoch + 1)
    expect(await reservedRequests(ISOLATED.id)).toBe(sourceBefore)
    expect(
      (await reservedRequests(TARGETS[0]!.id)) + (await reservedRequests(TARGETS[1]!.id))
    ).toBe(targetsBefore + 1)
    // One control added on the target; the source's control and splice kept.
    expect(await counters(identity)).toEqual({ controls: 2, splices: 1 })
    await expectReservationAccounting()

    // The source closes the host's sockets: each release takes its own units.
    expect(await stores[0]!.releaseActivity(identity, `control:${ISOLATED.id}:1`)).toBe(true)
    expect(await reservedRequests(ISOLATED.id)).toBe(sourceBefore - 1)
    expect(await counters(identity)).toEqual({ controls: 1, splices: 1 })
    expect(await stores[0]!.releaseActivity(identity, 'splice:keep-1')).toBe(true)
    expect(await reservedRequests(ISOLATED.id)).toBe(0)
    // The target's control survives the source's releases.
    expect(await counters(identity)).toEqual({ controls: 1, splices: 0 })
    await expectReservationAccounting()
  }, 30_000)

  it('re-places an isolated incumbent while the source row is held', async () => {
    await resetFleet()
    const { identity, first } = await seedActiveHostOnIsolatedSource(911)
    const sourceBefore = await reservedRequests(ISOLATED.id)
    const release = await holdCellRows([ISOLATED.id])
    try {
      // Held far past the 500ms bounded wait: a placement that asked for the
      // source row could not finish inside this window.
      const moved = await Promise.race([
        stores[1]!.assign(identity, 'us-central1'),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 3_000))
      ])
      expect(moved).not.toBe('blocked')
      expect(moved).toMatchObject({ assignmentEpoch: first.assignmentEpoch + 1 })
    } finally {
      await release()
    }
    expect(await reservedRequests(ISOLATED.id)).toBe(sourceBefore)
    await expectReservationAccounting()
  }, 30_000)

  it('waits for the target rows it increments', async () => {
    await resetFleet()
    const { identity, first } = await seedActiveHostOnIsolatedSource(912)
    const targetsBefore =
      (await reservedRequests(TARGETS[0]!.id)) + (await reservedRequests(TARGETS[1]!.id))
    const release = await holdCellRows(TARGETS.map(({ id }) => id))
    let settled = false
    const placement = stores[1]!.assign(identity, 'us-central1').finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(settled).toBe(false)
    await release()
    expect(await placement).toMatchObject({ assignmentEpoch: first.assignmentEpoch + 1 })
    expect(
      (await reservedRequests(TARGETS[0]!.id)) + (await reservedRequests(TARGETS[1]!.id))
    ).toBe(targetsBefore + 1)
    await expectReservationAccounting()
  }, 30_000)

  it('keeps the pin when no general cell in any region has headroom', async () => {
    await resetFleet()
    const { identity, first } = await seedActiveHostOnIsolatedSource(913)
    const sourceBefore = await reservedRequests(ISOLATED.id)
    await databases[0]!.query(
      `UPDATE relay_cells SET reserved_requests = capacity_requests WHERE cell_id IN (?, ?, ?)`,
      [...TARGETS, OTHER_REGION].map(({ id }) => id)
    )
    try {
      expect(await stores[1]!.assign(identity, 'us-central1')).toMatchObject({
        cellId: ISOLATED.id,
        assignmentEpoch: first.assignmentEpoch
      })
      expect(await reservedRequests(ISOLATED.id)).toBe(sourceBefore)
      expect(await counters(identity)).toEqual({ controls: 1, splices: 1 })
    } finally {
      await databases[0]!.query(
        `UPDATE relay_cells SET reserved_requests = 0 WHERE cell_id IN (?, ?, ?)`,
        [...TARGETS, OTHER_REGION].map(({ id }) => id)
      )
    }
  }, 30_000)

  it('moves to another region when its own is at the connection cap, without the source row', async () => {
    await resetFleet()
    const { identity, first } = await seedActiveHostOnIsolatedSource(917)
    const sourceBefore = await reservedRequests(ISOLATED.id)
    await heartbeatAll(Object.fromEntries(TARGETS.map(({ id }) => [id, 600])))
    const release = await holdCellRows([ISOLATED.id])
    try {
      const moved = await Promise.race([
        stores[1]!.assign(identity, 'us-central1'),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 3_000))
      ])
      expect(moved).toMatchObject({
        cellId: OTHER_REGION.id,
        region: 'asia-east2',
        assignmentEpoch: first.assignmentEpoch + 1
      })
    } finally {
      await release()
      await heartbeatAll()
    }
    expect(await reservedRequests(ISOLATED.id)).toBe(sourceBefore)
    expect(await reservedRequests(OTHER_REGION.id)).toBe(1)
    await expectReservationAccounting()
  }, 30_000)
  it('places a dormant host without asking for its old cell row', async () => {
    await resetFleet()
    const identity = hostIdentity(914)
    await applySelector({ [TARGETS[0]!.id]: 'migration-only', [TARGETS[1]!.id]: 'migration-only' })
    const first = await stores[0]!.assign(identity, 'us-central1')
    expect(first.cellId).toBe(ISOLATED.id)
    // Dormant: no units held and no activity inside the dormancy window.
    await databases[0]!.query(
      `DELETE FROM relay_assignment_activity_leases WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    await databases[0]!.query(
      `UPDATE relay_assignments SET reserved_controls = 0, last_activity_at = ?
       WHERE user_id = ? AND relay_host_id = ?`,
      [NOW - ASSIGNMENT_LIMITS.dormantTtlMs, identity.userId, identity.relayHostId]
    )
    await databases[0]!.query(`UPDATE relay_cells SET reserved_requests = 0 WHERE cell_id = ?`, [
      ISOLATED.id
    ])
    await applySelector({ [TARGETS[0]!.id]: 'general', [TARGETS[1]!.id]: 'general' })
    await applySelector({ [ISOLATED.id]: 'migration-only' }, [ISOLATED.id])

    const release = await holdCellRows([ISOLATED.id])
    try {
      const moved = await Promise.race([
        stores[1]!.assign(identity, 'us-central1'),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 3_000))
      ])
      expect(moved).toMatchObject({ assignmentEpoch: first.assignmentEpoch + 1 })
      expect(TARGETS.map(({ id }) => id)).toContain(moved === 'blocked' ? moved : moved.cellId)
    } finally {
      await release()
    }
    await expectReservationAccounting()
  }, 30_000)
  // Moves a seeded host onto TARGETS[0] next to another host whose splice there
  // outlives the test, so an over-charge shows instead of clamping at zero.
  async function seedMovedHostBesideNeighbour(index: number): Promise<{
    identity: { userId: string; relayHostId: string }
    neighbour: { userId: string; relayHostId: string }
  }> {
    const { identity } = await seedActiveHostOnIsolatedSource(index)
    await applySelector({ [TARGETS[1]!.id]: 'migration-only' })
    const neighbour = hostIdentity(index + 50)
    expect((await stores[0]!.assign(neighbour, 'us-central1')).cellId).toBe(TARGETS[0]!.id)
    await stores[0]!.acquireActivity(neighbour, {
      activityId: 'splice:neighbour',
      kind: 'splice',
      cellId: TARGETS[0]!.id,
      expiresAt: NOW + 10 * 60 * 60_000
    })
    expect((await stores[1]!.assign(identity, 'us-central1')).cellId).toBe(TARGETS[0]!.id)
    expect(await counters(identity)).toEqual({ controls: 2, splices: 1 })
    await expectReservationAccounting()
    return { identity, neighbour }
  }

  it('leaves a host with leases on two cells to the lease sweep', async () => {
    await resetFleet()
    const { identity } = await seedMovedHostBesideNeighbour(915)
    // Past every lease but the neighbour's splice.
    const later = new RelayAssignmentStore(databases[0]!, () => NOW + 60 * 60_000, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    try {
      // Aggregate expiry first, with the source's leases still present: the
      // order a lease sweep skipped on a busy row leaves behind.
      await later.releaseExpiredActivity()
      expect(await counters(identity)).toEqual({ controls: 2, splices: 1 })
      await expectReservationAccounting()
      await later.releaseExpiredActivityLeases()
      await later.releaseExpiredActivity()
      expect(await counters(identity)).toEqual({ controls: 0, splices: 0 })
      expect(await reservedRequests(ISOLATED.id)).toBe(0)
      // Only the neighbour's splice is left on the target.
      expect(await reservedRequests(TARGETS[0]!.id)).toBe(2)
      await expectReservationAccounting()
    } finally {
      await applySelector({ [TARGETS[1]!.id]: 'general' })
    }
  }, 30_000)

  it('frees the source leases on their own cell when the target dies', async () => {
    await resetFleet()
    const { identity } = await seedMovedHostBesideNeighbour(916)
    // The roll finishes, then the target stops heartbeating before the source
    // has released the host. Uncapped, so no fence is needed to move off it.
    await applySelector({ [ISOLATED.id]: 'general' })
    await databases[0]!.query(`UPDATE relay_cell_runtime SET ready = 0 WHERE cell_id = ?`, [
      TARGETS[0]!.id
    ])
    await databases[0]!.query(`DELETE FROM relay_cell_connection_limits WHERE cell_id = ?`, [
      TARGETS[0]!.id
    ])
    try {
      const moved = await stores[1]!.assign(identity, 'us-central1')
      expect(moved.cellId).toBe(ISOLATED.id)
      expect(await counters(identity)).toEqual({ controls: 1, splices: 0 })
      // The deleted source leases took their units with them; a late release
      // from the source finds nothing and charges nothing.
      expect(await stores[0]!.releaseActivity(identity, `control:${ISOLATED.id}:1`)).toBe(false)
      expect(await reservedRequests(ISOLATED.id)).toBe(1)
      expect(await reservedRequests(TARGETS[0]!.id)).toBe(3)
      await expectReservationAccounting()
    } finally {
      // Re-registers the connection limit, then the heartbeat restores ready.
      await stores[0]!.reconcileCells(CELLS, false)
      await heartbeatAll()
      await applySelector({ [TARGETS[1]!.id]: 'general' })
    }
  }, 30_000)
  // A host main's old placement left behind: its counters were reset while its
  // source lease stayed, and the lease's release floored them at zero.
  async function seedDriftedHost(
    index: number,
    counted: { controls: number; unbackedSourceUnits: number }
  ): Promise<{ identity: { userId: string; relayHostId: string }; epoch: number }> {
    const identity = hostIdentity(index)
    await applySelector({ [TARGETS[0]!.id]: 'migration-only', [TARGETS[1]!.id]: 'migration-only' })
    const first = await stores[0]!.assign(identity, 'us-central1')
    expect(first.cellId).toBe(ISOLATED.id)
    await stores[0]!.activateControl(identity, {
      cellId: ISOLATED.id,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    await databases[0]!.query(
      `UPDATE relay_assignments SET reserved_controls = ? WHERE user_id = ? AND relay_host_id = ?`,
      [counted.controls, identity.userId, identity.relayHostId]
    )
    // Units the source still counts with no lease behind them.
    await databases[0]!.query(
      `UPDATE relay_cells SET reserved_requests = reserved_requests + ? WHERE cell_id = ?`,
      [counted.unbackedSourceUnits, ISOLATED.id]
    )
    await applySelector({ [TARGETS[0]!.id]: 'general', [TARGETS[1]!.id]: 'general' })
    await applySelector({ [ISOLATED.id]: 'migration-only' }, [ISOLATED.id])
    return { identity, epoch: first.assignmentEpoch }
  }

  it('heals counters below the leases on the narrowed path', async () => {
    await resetFleet()
    const { identity, epoch } = await seedDriftedHost(918, { controls: 0, unbackedSourceUnits: 0 })
    expect(await counters(identity)).toEqual({ controls: 0, splices: 0 })
    await expectReservationAccounting()
    const release = await holdCellRows([ISOLATED.id])
    try {
      const moved = await Promise.race([
        stores[1]!.assign(identity, 'us-central1'),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 3_000))
      ])
      expect(moved).toMatchObject({ assignmentEpoch: epoch + 1 })
      expect(TARGETS.map(({ id }) => id)).toContain(moved === 'blocked' ? moved : moved.cellId)
    } finally {
      await release()
    }
    // The kept source control plus the new one.
    expect(await counters(identity)).toEqual({ controls: 2, splices: 0 })
    await expectReservationAccounting()
    expect(await stores[0]!.releaseActivity(identity, `control:${ISOLATED.id}:1`)).toBe(true)
    expect(await counters(identity)).toEqual({ controls: 1, splices: 0 })
    expect(await reservedRequests(ISOLATED.id)).toBe(0)
    await expectReservationAccounting()
  }, 30_000)

  it('takes the all-rows path for units no lease backs', async () => {
    await resetFleet()
    const { identity, epoch } = await seedDriftedHost(919, { controls: 3, unbackedSourceUnits: 2 })
    await expectReservationAccountingExcept(ISOLATED.id)
    const release = await holdCellRows([ISOLATED.id])
    const held = stores[1]!.assign(identity, 'us-central1').then(
      () => 'placed' as const,
      () => 'failed' as const
    )
    try {
      // It needs the source row to take the unbacked units off it, so while the
      // row is held it either waits or times out; it never places.
      expect(
        await Promise.race([
          held,
          new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 1_000))
        ])
      ).not.toBe('placed')
    } finally {
      await release()
    }
    await held
    // Whether the held dial finished after the release or failed, the next one
    // lands the single move.
    expect(await stores[1]!.assign(identity, 'us-central1')).toMatchObject({
      assignmentEpoch: epoch + 1
    })
    expect(await counters(identity)).toEqual({ controls: 2, splices: 0 })
    await expectReservationAccounting()
  }, 30_000)
  it('refuses at once while the host’s own release holds its assignment row', async () => {
    await resetFleet()
    const { identity, epoch } = await seedDriftedHost(921, { controls: 1, unbackedSourceUnits: 0 })
    const release = await holdRows(
      `SELECT user_id FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    try {
      const startedAt = performance.now()
      await expect(stores[1]!.assign(identity, 'us-central1')).rejects.toBeInstanceOf(
        RelayAssignmentRowBusyError
      )
      // An isolated pin gets no wait: far under the 1s a release can hold it.
      expect(performance.now() - startedAt).toBeLessThan(500)
    } finally {
      await release()
    }
    expect((await stores[0]!.resolve(identity))?.assignmentEpoch).toBe(epoch)
    expect((await stores[1]!.assign(identity, 'us-central1')).assignmentEpoch).toBe(epoch + 1)
    await expectReservationAccounting()
  }, 30_000)

  it('waits up to a second for the row of a host pinned to a live general cell', async () => {
    await resetFleet()
    const identity = hostIdentity(922)
    const first = await stores[0]!.assign(identity, 'us-central1')
    const holdAssignment = async (): Promise<() => Promise<void>> =>
      await holdRows(
        `SELECT user_id FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )

    // A short hold, like a calm host's own release: the sticky re-grant waits.
    const shortHold = await holdAssignment()
    const regrant = stores[1]!.assign(identity, 'us-central1')
    await new Promise((resolve) => setTimeout(resolve, 200))
    await shortHold()
    expect(await regrant).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })

    // Held past the bound: refused, after about the bound and not the pool's.
    const longHold = await holdAssignment()
    try {
      const startedAt = performance.now()
      await expect(stores[1]!.assign(identity, 'us-central1')).rejects.toBeInstanceOf(
        RelayAssignmentRowBusyError
      )
      const waitedMs = performance.now() - startedAt
      expect(waitedMs).toBeGreaterThanOrEqual(900)
      expect(waitedMs).toBeLessThan(2_000)
    } finally {
      await longHold()
    }
  }, 30_000)
  it('never waits on the assignment row while its retry holds the pinned cell row', async () => {
    await resetFleet()
    const identity = hostIdentity(923)
    const first = await stores[0]!.assign(identity, 'us-central1')
    // No control lease, so the sticky re-grant needs the cell row itself.
    expect(
      await stores[0]!.releaseActivity(identity, `control-pending:${first.assignmentEpoch}`)
    ).toBe(true)
    // The first attempt finds the cell row busy and retries cell row first.
    const releaseCell = await holdCellRows([first.cellId])
    const regrant = stores[1]!.assign(identity, 'us-central1').then(
      () => 'granted',
      (error: unknown) => error
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    // The row the retry reaches next, held the way this host's release holds it.
    const releaseAssignment = await holdRows(
      `SELECT user_id FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
      [identity.userId, identity.relayHostId]
    )
    try {
      await releaseCell()
      const cellFreedAt = performance.now()
      expect(await regrant).toBeInstanceOf(RelayAssignmentRowBusyError)
      // NOWAIT once the cell row is held: nowhere near the 1s bounded wait.
      expect(performance.now() - cellFreedAt).toBeLessThan(300)
    } finally {
      await releaseAssignment()
    }
  }, 30_000)
})
