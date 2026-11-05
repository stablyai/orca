import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from '../assignment-store.js'
import {
  encodeMembership,
  type CellAdmissionMembership,
  type CellAdmissionState
} from '../../cell/admission/cell-admission-selector.js'
import type { RelayCellConfig } from '../../config.js'
import { openRelayDatabase, type RelayDatabase } from '../../database/database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const DIRECTOR_INSTANCES = 5
const DIRECTOR_POOL_MAX = 3
const DIRECTOR_APPLICATION = 'drain-release-contention-director'

const USER_PREFIX = 'drain-release-contention'
const NOW = 1_000_000
const CAPPED = {
  capacityRequests: 6_000,
  connectionHardCap: 3_000,
  connectionUnobservedBound: 60
} as const
const SOURCE: RelayCellConfig = {
  id: 'drain-release-contention-a-source',
  url: 'https://drain-release-contention-source.example.test',
  region: 'asia-east2',
  ...CAPPED
}
const TARGETS: RelayCellConfig[] = ['b', 'c', 'd'].map((suffix) => ({
  id: `drain-release-contention-${suffix}-target`,
  url: `https://drain-release-contention-${suffix}-target.example.test`,
  region: 'asia-east2',
  ...CAPPED
}))
// Next to the database. Taken only once every Asia neighbour is at its cap.
const US_CELL: RelayCellConfig = {
  id: 'drain-release-contention-e-us',
  url: 'https://drain-release-contention-us.example.test',
  region: 'us-central1',
  ...CAPPED
}
const CELLS = [SOURCE, ...TARGETS, US_CELL]

type Identity = { userId: string; relayHostId: string }
type Instance = { database: RelayDatabase; store: RelayAssignmentStore }

function hostIdentity(index: number): Identity {
  return {
    userId: `${USER_PREFIX}-${index}`,
    // Relay host ids are fixed-width opaque ids.
    relayHostId: `drainrel${String(index).padStart(8, '0')}`
  }
}

describePostgres('PostgreSQL drain releases against director placement', () => {
  const storeOptions = { requireLiveCells: true, heartbeatTtlMs: 45_000 }
  const directors: Instance[] = []
  let observer: RelayDatabase

  function admin(): Instance {
    return directors[0]!
  }

  async function applySelector(
    states: Record<string, CellAdmissionState>,
    rollIsolatedCells?: string[]
  ): Promise<void> {
    const current = await admin().store.inspectCellAdmissionSelector()
    // Built from relay_cells: the apply requires exact coverage of a shared fleet.
    const fleet = await admin().database.query(
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
    await admin().store.applyCellAdmissionSelector({
      attemptId: `drain-release-${current.selector.generation}`,
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

  // Other Postgres files write admission through the generation-0 helpers, so
  // the selector goes back to generation 0 exactly as found.
  async function resetSelectorBoundary(): Promise<void> {
    await admin().database.query(
      `UPDATE relay_admission_selectors SET generation = 0, attempt_id = NULL
       WHERE selector_id = 'general'`
    )
    await admin().database.query(
      `DELETE FROM relay_admission_selector_intents WHERE attempt_id LIKE 'drain-release-%'`
    )
    await admin().store.reconcileCells([], false)
  }

  async function deleteHostRows(): Promise<void> {
    for (const table of [
      'relay_control_capabilities',
      'relay_control_connection_reservations',
      'relay_assignment_activity_leases',
      'relay_assignment_migrations',
      'relay_assignment_region_preferences',
      'relay_assignments'
    ]) {
      await admin().database.query(`DELETE FROM ${table} WHERE user_id LIKE '${USER_PREFIX}-%'`)
    }
  }

  // `atCap` reports those cells at their connection cap: no headroom left.
  async function heartbeatAll(atCap: RelayCellConfig[] = []): Promise<void> {
    for (const [index, config] of CELLS.entries()) {
      await admin().store.recordCellHeartbeat({
        cellId: config.id,
        cellUrl: config.url,
        cellIncarnation: `2222222${index}-2222-4222-8222-222222222222`,
        startedAt: NOW - 1_000,
        ready: true,
        observedRequests: 0,
        region: config.region,
        // The cell checks enforced = total + in-flight + reserved.
        totalConnections: atCap.includes(config) ? CAPPED.connectionHardCap : 0,
        inFlightConnections: 0,
        reservedConnectionUnits: 0,
        enforcedConnectionUnits: atCap.includes(config) ? CAPPED.connectionHardCap : 0,
        connectionHardCap: CAPPED.connectionHardCap,
        connectionUnobservedBound: CAPPED.connectionUnobservedBound
      })
    }
  }

  // Holds `cellIds`' relay_cells rows in an open transaction until the returned release runs.
  async function holdCellRows(cellIds: string[]): Promise<() => Promise<void>> {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let held!: () => void
    const acquired = new Promise<void>((resolve) => (held = resolve))
    const holder = observer.transaction(async (transaction) => {
      await transaction.queryLocked(
        `SELECT cell_id FROM relay_cells WHERE cell_id IN (${cellIds.map(() => '?').join(', ')})
         ORDER BY cell_id ASC`,
        cellIds
      )
      held()
      await released
    })
    await acquired
    return async () => {
      release()
      await holder
    }
  }

  // Every host holds a live control lease on the source, then the source is
  // isolated for a roll: the state an Asia drain starts from.
  async function seed(hosts: Identity[]): Promise<void> {
    await deleteHostRows()
    await admin().database.query(
      `UPDATE relay_cells SET reserved_requests = 0 WHERE cell_id LIKE '${USER_PREFIX}-%'`
    )
    // Restoring the source to general also clears the previous run's roll stamp.
    await applySelector({
      [SOURCE.id]: 'general',
      ...Object.fromEntries(TARGETS.map((target) => [target.id, 'migration-only' as const]))
    })
    for (const identity of hosts) {
      const grant = await admin().store.assign(identity, 'asia-east2', 'asia-east2')
      expect(grant.cellId).toBe(SOURCE.id)
      await admin().store.activateControl(identity, {
        cellId: SOURCE.id,
        assignmentEpoch: grant.assignmentEpoch,
        generation: 1
      })
    }
    await applySelector(
      Object.fromEntries(TARGETS.map((target) => [target.id, 'general' as const]))
    )
    await applySelector({ [SOURCE.id]: 'migration-only' }, [SOURCE.id])
  }

  beforeAll(async () => {
    for (let index = 0; index < DIRECTOR_INSTANCES; index += 1) {
      const database = await openRelayDatabase({
        databaseUrl,
        dataDir: '',
        poolMax: DIRECTOR_POOL_MAX,
        applicationName: DIRECTOR_APPLICATION
      })
      directors.push({
        database,
        store: new RelayAssignmentStore(database, () => NOW, storeOptions)
      })
    }
    observer = await openRelayDatabase({ databaseUrl, dataDir: '', poolMax: 1 })
    await deleteHostRows()
    await admin().store.reconcileCells(CELLS, false)
    await resetSelectorBoundary()
    await heartbeatAll()
  })

  afterAll(async () => {
    if (directors.length > 0) {
      await deleteHostRows()
      // Cells before the selector rebuild, or its membership names missing rows.
      for (const config of CELLS) {
        for (const table of [
          'relay_cell_connection_snapshots',
          'relay_cell_connection_runtime',
          'relay_cell_connection_limits',
          'relay_cell_runtime',
          'relay_cell_admission',
          'relay_cell_regions',
          'relay_cells'
        ]) {
          await admin().database.query(`DELETE FROM ${table} WHERE cell_id = ?`, [config.id])
        }
      }
      await resetSelectorBoundary()
    }
    for (const instance of directors) {
      await instance.database.close()
    }
    await observer?.close()
  })

  it('places a reconnecting host off the isolated source while that source row is held', async () => {
    await heartbeatAll()
    const host = hostIdentity(9_000)
    await seed([host])
    // A drain release holds the source row for its whole transaction; target-only placement never asks for it.
    const sourceHeld = await holdCellRows([SOURCE.id])
    try {
      const grant = await Promise.race([
        directors[1]!.store.assign(host, 'asia-east2', 'asia-east2'),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 3_000))
      ])
      expect(grant).not.toBe('blocked')
      expect(TARGETS.map(({ id }) => id)).toContain(grant === 'blocked' ? null : grant.cellId)
    } finally {
      await sourceHeld()
    }
    // Control: the same hold on the target rows does block a placement, so the hold above was real.
    const other = hostIdentity(9_001)
    await seed([other])
    const targetsHeld = await holdCellRows(TARGETS.map(({ id }) => id))
    const placement = directors[2]!.store.assign(other, 'asia-east2', 'asia-east2')
    try {
      const raced = await Promise.race([
        placement.then(() => 'placed' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 1_000))
      ])
      expect(raced).toBe('blocked')
    } finally {
      await targetsHeld()
    }
    expect((await placement).cellId).not.toBe(SOURCE.id)
  }, 30_000)
})
