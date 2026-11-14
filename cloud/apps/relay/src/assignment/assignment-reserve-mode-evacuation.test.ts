import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayCellConfig } from '../config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from '../database/database.js'

const CELLS: RelayCellConfig[] = [
  { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
  { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
]

describe('evacuation from reserve-mode cells', () => {
  let database: RelayDatabase | undefined

  afterEach(async () => {
    await database?.close()
    database = undefined
  })

  async function setup(now: () => number) {
    database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, now)
    await store.reconcileCells(CELLS)
    return store
  }

  // A host whose source cell kept no lease for it, as a memory cell's control and phones do.
  async function registeredEvacuationWithoutSourceLeases(store: RelayAssignmentStore) {
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    expect(first.cellId).toBe('cell-a')
    const migration = await store.startEvacuation(identity, 'cell-b')
    await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    await store.releaseActivity(identity, `control-pending:${first.assignmentEpoch}`)
    return { identity, migration }
  }

  it('completes no evacuation from a reserve source, though it holds no source lease', async () => {
    const now = () => 1_000
    const store = await setup(now)
    const { identity, migration } = await registeredEvacuationWithoutSourceLeases(store)
    // setCellAdmitMode refuses this with the migration open; written directly to reach the second guard.
    await database!.query(
      `INSERT INTO relay_cell_admit_modes (cell_id, admit_mode, updated_at) VALUES ('cell-a', 'reserve', 1000)`
    )
    const fresh = new RelayAssignmentStore(database!, now)
    await expect(fresh.completeEvacuation(identity, migration.assignmentEpoch)).rejects.toThrow(
      'cell_in_reserve_mode'
    )
    await expect(fresh.completeReadyEvacuations()).rejects.toThrow('cell_in_reserve_mode')
    expect(
      await database!.query(`SELECT completed_at FROM relay_assignment_migrations`)
    ).toEqual([{ completed_at: null }])
    // The same host on a db source completes: the guard, not the fixture, held it.
    await store.setCellAdmitMode('cell-a', 'db')
    expect(await store.completeReadyEvacuations()).toBe(1)
  })
})
