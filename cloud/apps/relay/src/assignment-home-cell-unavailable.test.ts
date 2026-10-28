import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore, RelayHomeCellUnavailableError } from './assignment-store.js'
import type { RelayCellConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'

const HEARTBEAT_TTL_MS = 45_000
const START_MS = 100
const IDENTITY = { userId: 'user-1', relayHostId: 'host000000000001' }

// A connection-limited cell is what makes the committed fence mandatory, and
// that is the branch which used to answer "capacity exhausted".
const FENCED_CELL: RelayCellConfig = {
  id: 'home',
  url: 'https://home.example.com',
  capacityRequests: 1_000,
  connectionHardCap: 600,
  connectionUnobservedBound: 50
}

const databases: RelayDatabase[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close()
})

interface Harness {
  store: RelayAssignmentStore
  heartbeat: (cell: RelayCellConfig, ready: boolean) => Promise<void>
  setNow: (value: number) => void
}

async function setup(cells: RelayCellConfig[] = [FENCED_CELL]): Promise<Harness> {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  let now = START_MS
  const store = new RelayAssignmentStore(database, () => now, {
    requireLiveCells: true,
    heartbeatTtlMs: HEARTBEAT_TTL_MS
  })
  await store.reconcileCells(cells, true)
  const heartbeat = async (cell: RelayCellConfig, ready: boolean): Promise<void> => {
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: `1111111${cells.indexOf(cell)}-1111-4111-8111-111111111111`,
      startedAt: 50,
      ready,
      observedRequests: 0,
      ...(cell.connectionHardCap === undefined
        ? {}
        : {
            totalConnections: 0,
            inFlightConnections: 0,
            reservedConnectionUnits: 0,
            enforcedConnectionUnits: 0,
            connectionHardCap: cell.connectionHardCap,
            connectionUnobservedBound: cell.connectionUnobservedBound
          })
    })
  }
  for (const cell of cells) await heartbeat(cell, true)
  return { store, heartbeat, setNow: (value: number) => (now = value) }
}

async function assignFailure(store: RelayAssignmentStore): Promise<unknown> {
  return await store.assign(IDENTITY).then(
    () => new Error('assign unexpectedly succeeded'),
    (error: unknown) => error
  )
}

function homeCellError(error: unknown): RelayHomeCellUnavailableError {
  expect(error).toBeInstanceOf(RelayHomeCellUnavailableError)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the assertion above.
  return error as RelayHomeCellUnavailableError
}

describe('home cell unavailable', () => {
  it('names a readiness failure rather than reporting fleet capacity', async () => {
    const { store, heartbeat, setNow } = await setup()
    await store.assign(IDENTITY)
    setNow(START_MS + 1_000)
    await heartbeat(FENCED_CELL, false)

    const error = homeCellError(await assignFailure(store))

    expect(error.message).toBe('relay_home_cell_unavailable')
    expect(error.unavailableCause).toBe('not_ready')
    expect(error.cellId).toBe(FENCED_CELL.id)
  })

  it('names a heartbeat gap as unheard even though the cell last reported ready', async () => {
    const { store, setNow } = await setup()
    await store.assign(IDENTITY)
    setNow(START_MS + HEARTBEAT_TTL_MS + 1)

    expect(homeCellError(await assignFailure(store)).unavailableCause).toBe('unheard')
  })

  it('names a drained cell as draining ahead of its heartbeat gap', async () => {
    const { store, setNow } = await setup()
    await store.assign(IDENTITY)
    await store.configureCell(FENCED_CELL, false)
    setNow(START_MS + HEARTBEAT_TTL_MS + 1)

    expect(homeCellError(await assignFailure(store)).unavailableCause).toBe('draining')
  })

  it('still reports capacity exhaustion when the fleet has no headroom', async () => {
    const { store } = await setup([{ ...FENCED_CELL, capacityRequests: 1 }])
    await store.assign(IDENTITY)

    await expect(
      store.assign({ userId: 'user-2', relayHostId: 'host000000000002' })
    ).rejects.toThrow('relay_capacity_exhausted')
  })

  it('rehomes instead of rejecting when the unavailable cell needs no fence', async () => {
    const home: RelayCellConfig = {
      id: 'home',
      url: 'https://home.example.com',
      capacityRequests: 1_000
    }
    const spare: RelayCellConfig = {
      id: 'spare',
      url: 'https://spare.example.com',
      capacityRequests: 1_000
    }
    const { store, heartbeat, setNow } = await setup([home, spare])
    expect((await store.assign(IDENTITY)).cellId).toBe(home.id)
    setNow(START_MS + 1_000)
    await heartbeat(home, false)

    expect((await store.assign(IDENTITY)).cellId).toBe(spare.id)
  })
})
