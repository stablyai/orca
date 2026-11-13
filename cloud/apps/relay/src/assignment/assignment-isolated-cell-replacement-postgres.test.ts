import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentRowBusyError, RelayAssignmentStore } from './assignment-store.js'
import {
  encodeMembership,
  type CellAdmissionMembership,
  type CellAdmissionState
} from '../cell/admission/cell-admission-selector.js'
import type { RelayCellConfig } from '../config.js'
import { openRelayDatabase, type RelayDatabase } from '../database/database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const USER_PREFIX = 'isolated-replacement-postgres'
function databaseApplicationName(index: number): string {
  return `${USER_PREFIX}-${process.pid}-${index}`
}

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

  async function waitForLock(table: 'relay_cells' | 'relay_assignments'): Promise<void> {
    await vi.waitFor(
      async () => {
        const rows = await databases[0]!.query(
          `SELECT COUNT(*) AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND application_name = ? AND query LIKE ? AND query LIKE '%FOR UPDATE%'`,
          [databaseApplicationName(1), `%${table}%`]
        )
        expect(Number(rows[0]?.['waiting'])).toBeGreaterThan(0)
      },
      { timeout: 4_000, interval: 10 }
    )
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
    const fleet = await databases[0]!.query(`SELECT cell_id FROM relay_cells ORDER BY cell_id ASC`)
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

  // Shared PostgreSQL suites use generation-0 helpers; restore the exact selector boundary or later files fail admission_selector_boundary_active.
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
      databases.push(
        await openRelayDatabase({
          databaseUrl,
          dataDir: '',
          applicationName: databaseApplicationName(index)
        })
      )
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
      // Drop cell rows before rebuilding membership or later reads fail admission_selector_membership_drift.
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
    const granted = raced.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    expect(granted.length).toBeGreaterThan(0)

    // Concurrent dials may grant repeatedly but commit one move: one epoch/unit on target, preserving source leases until release.
    const settled = await stores[0]!.resolve(identity)
    expect(settled?.assignmentEpoch).toBe(first.assignmentEpoch + 1)
    expect(settled?.cellId).not.toBe(ISOLATED.id)
    for (const grant of granted) expect(grant.cellId).toBe(settled?.cellId)
    expect(await reservedRequests(ISOLATED.id)).toBe(sourceBefore)
    expect(
      (await reservedRequests(TARGETS[0]!.id)) + (await reservedRequests(TARGETS[1]!.id))
    ).toBe(targetBaseline + 1)
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
    let releaseAssignment: (() => Promise<void>) | undefined
    try {
      await waitForLock('relay_cells')
      releaseAssignment = await holdRows(
        `SELECT user_id FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
      await releaseCell()
      const cellFreedAt = performance.now()
      expect(await regrant).toBeInstanceOf(RelayAssignmentRowBusyError)
      // NOWAIT once the cell row is held: nowhere near the 1s bounded wait.
      expect(performance.now() - cellFreedAt).toBeLessThan(300)
    } finally {
      await releaseAssignment?.()
      await releaseCell()
      await regrant
    }
  }, 30_000)
})
