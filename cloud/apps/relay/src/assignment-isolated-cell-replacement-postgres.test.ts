import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
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
const CELLS = [ISOLATED, ...TARGETS]
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

  async function heartbeatAll(): Promise<void> {
    for (const [index, cell] of CELLS.entries()) {
      await stores[0]!.recordCellHeartbeat({
        cellId: cell.id,
        cellUrl: cell.url,
        cellIncarnation: `1111111${index}-1111-4111-8111-111111111111`,
        startedAt: 50,
        ready: true,
        observedRequests: 0,
        region: cell.region,
        totalConnections: 0,
        inFlightConnections: 0,
        reservedConnectionUnits: 0,
        enforcedConnectionUnits: 0,
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
      attemptId: `isolated-${current.selector.generation}-${Object.keys(states).join('-')}`,
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

    expect(await reservedRequests(ISOLATED.id)).toBe(sourceBaseline)
    expect(
      (await reservedRequests(TARGETS[0]!.id)) + (await reservedRequests(TARGETS[1]!.id))
    ).toBe(targetBaseline + HOST_COUNT)

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
    // committed: the epoch advances by exactly one and the reservation moves
    // exactly one unit.
    const settled = await stores[0]!.resolve(identity)
    expect(settled?.assignmentEpoch).toBe(first.assignmentEpoch + 1)
    expect(settled?.cellId).not.toBe(ISOLATED.id)
    for (const grant of granted) expect(grant.cellId).toBe(settled?.cellId)
    expect(await reservedRequests(ISOLATED.id)).toBe(sourceBefore - 1)
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
})
