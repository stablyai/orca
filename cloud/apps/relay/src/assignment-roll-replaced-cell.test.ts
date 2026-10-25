import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore, RelayHomeCellUnavailableError } from './assignment-store.js'
import {
  encodeMembership,
  type CellAdmissionMembership,
  type CellAdmissionState
} from './cell-admission-selector.js'
import type { RelayCellConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'

// Production 2026-10-24, production-gce-c15: a same-cap roll isolates the cell, drains it,
// then replaces its one VM. A host that was offline through the drain still names the cell,
// and redialled in the ~45 s before the new process was ready.
const HEARTBEAT_TTL_MS = 45_000
const START_MS = 100
const IDENTITY = { userId: 'user-a', relayHostId: 'host000000000001' }
const OLD_INCARNATION = '11111111-1111-4111-8111-111111111111'
const NEW_INCARNATION = '22222222-2222-4222-8222-222222222222'
const OTHER_INCARNATION = '33333333-3333-4333-8333-333333333333'
// Capped is what makes the dead-cell path refuse with relay_home_cell_unavailable.
const CAPPED = {
  capacityRequests: 1_000,
  connectionHardCap: 600,
  connectionUnobservedBound: 50
} as const
const SOURCE: RelayCellConfig = {
  id: 'us-c1',
  url: 'https://us-c1.example.com',
  region: 'us-central1',
  ...CAPPED
}
const TARGET: RelayCellConfig = {
  id: 'us-c2',
  url: 'https://us-c2.example.com',
  region: 'us-central1',
  ...CAPPED
}
const OTHER_REGION: RelayCellConfig = {
  id: 'asia-c1',
  url: 'https://asia-c1.example.com',
  region: 'asia-east2',
  ...CAPPED
}

const databases: RelayDatabase[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) {
    await database.close()
  }
})

type Beat = {
  incarnation?: string
  startedAt?: number
  ready?: boolean
  totalConnections?: number
}

async function setup(cells: RelayCellConfig[] = [SOURCE, TARGET]) {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  let now = START_MS
  const store = new RelayAssignmentStore(database, () => now, {
    requireLiveCells: true,
    heartbeatTtlMs: HEARTBEAT_TTL_MS
  })
  await store.reconcileCells(cells, true)
  const heartbeat = async (cell: RelayCellConfig, beat: Beat = {}): Promise<void> => {
    const total = beat.totalConnections ?? 0
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation:
        beat.incarnation ?? (cell === SOURCE ? OLD_INCARNATION : OTHER_INCARNATION),
      startedAt: beat.startedAt ?? 50,
      ready: beat.ready ?? true,
      observedRequests: 0,
      region: cell.region,
      totalConnections: total,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: total,
      connectionHardCap: CAPPED.connectionHardCap,
      connectionUnobservedBound: CAPPED.connectionUnobservedBound
    })
  }
  for (const cell of cells) {
    await heartbeat(cell)
  }

  const applySelector = async (
    state: CellAdmissionState,
    rollIsolatedCells?: string[]
  ): Promise<void> => {
    const current = await store.inspectCellAdmissionSelector()
    const membership: CellAdmissionMembership = {
      existingOnly: state === 'existing-only' ? [SOURCE.id] : [],
      migrationOnly: state === 'migration-only' ? [SOURCE.id] : [],
      general: cells
        .filter((cell) => cell !== SOURCE || state === 'general')
        .map((cell) => cell.id)
    }
    await store.applyCellAdmissionSelector({
      attemptId: `attempt-${current.selector.generation}`,
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

  // The host lands on SOURCE, which the roll then isolates at START_MS.
  const first = await store.assign(IDENTITY, 'us-central1')
  expect(first.cellId).toBe(SOURCE.id)

  return {
    store,
    database,
    first,
    heartbeat,
    at: async (value: number): Promise<void> => {
      now = value
      for (const cell of cells) {
        if (cell !== SOURCE) {
          await heartbeat(cell)
        }
      }
    },
    isolateForRoll: async () => await applySelector('migration-only', [SOURCE.id]),
    park: async (state: CellAdmissionState) => await applySelector(state)
  }
}

// The old process stopped heartbeating at START_MS, so it is unheard from here.
const OLD_UNHEARD_AT = START_MS + HEARTBEAT_TTL_MS + 1_000

// Both routes that refused in production: a hinted assign (placement lane after its
// verification read finds the cell not live) and resolve, which then assigns.
async function hintedAssign(store: RelayAssignmentStore) {
  return await store.assign(IDENTITY, 'us-central1', 'us-central1', undefined, {
    hostRequested: true
  })
}

async function resolveRoute(store: RelayAssignmentStore) {
  return (await store.resolve(IDENTITY)) ?? (await store.assign(IDENTITY))
}

async function expectRefused(
  attempt: Promise<unknown>,
  cause: 'not_ready' | 'unheard'
): Promise<void> {
  const error = await attempt.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(RelayHomeCellUnavailableError)
  expect(error).toMatchObject({ unavailableCause: cause })
}

describe.each([
  ['hinted assign', hintedAssign],
  ['resolve', resolveRoute]
] as const)('a host offline through a roll redials via %s', (_route, redial) => {
  describe('while the replacement process boots (not ready)', () => {
    it('is re-placed when that process started after the roll isolated the cell', async () => {
      const { store, first, heartbeat, at, isolateForRoll } = await setup()
      await isolateForRoll()
      await at(20_000)
      await heartbeat(SOURCE, { incarnation: NEW_INCARNATION, startedAt: 15_000, ready: false })

      const moved = await redial(store)
      expect(moved).toMatchObject({ cellId: TARGET.id })
      expect(moved.assignmentEpoch).toBeGreaterThan(first.assignmentEpoch)
    })

    it('is refused while the process is the one that was running before isolation', async () => {
      const { store, heartbeat, at, isolateForRoll } = await setup()
      await isolateForRoll()
      await at(20_000)
      await heartbeat(SOURCE, { ready: false })

      await expectRefused(redial(store), 'not_ready')
    })

    it('is refused while the new process reports holding connections', async () => {
      const { store, heartbeat, at, isolateForRoll } = await setup()
      await isolateForRoll()
      await at(20_000)
      await heartbeat(SOURCE, {
        incarnation: NEW_INCARNATION,
        startedAt: 15_000,
        ready: false,
        totalConnections: 1
      })

      await expectRefused(redial(store), 'not_ready')
    })

    it('is refused once the new process itself goes unheard', async () => {
      const { store, heartbeat, at, isolateForRoll } = await setup()
      await isolateForRoll()
      await at(20_000)
      await heartbeat(SOURCE, { incarnation: NEW_INCARNATION, startedAt: 15_000, ready: false })
      await at(20_000 + HEARTBEAT_TTL_MS + 1_000)

      await expectRefused(redial(store), 'unheard')
    })

    it('is refused on an ordinary readiness dip with no roll stamp', async () => {
      const { store, heartbeat, at } = await setup()
      await at(20_000)
      await heartbeat(SOURCE, { incarnation: NEW_INCARNATION, startedAt: 15_000, ready: false })

      await expectRefused(redial(store), 'not_ready')
    })

    it('is refused on a migration-only cell parked without a roll stamp', async () => {
      const { store, heartbeat, at, park } = await setup()
      await park('migration-only')
      await at(20_000)
      await heartbeat(SOURCE, { incarnation: NEW_INCARNATION, startedAt: 15_000, ready: false })

      await expectRefused(redial(store), 'not_ready')
    })
  })

  // Residual: the old process is past its TTL and the new one has not heartbeated yet, so
  // nothing proves the drained sockets gone. The client's retry lands once the new one is heard.
  it('is still refused between the old process going unheard and the new one heartbeating', async () => {
    const { store, at, isolateForRoll } = await setup()
    await isolateForRoll()
    await at(OLD_UNHEARD_AT)

    await expectRefused(redial(store), 'unheard')
  })

  it('is refused when the roll stamp is stale, even with a new process', async () => {
    const { store, heartbeat, at, isolateForRoll } = await setup()
    await isolateForRoll()
    const stale = START_MS + 2 * 60 * 60_000 + 1
    await at(stale)
    await heartbeat(SOURCE, { incarnation: NEW_INCARNATION, startedAt: stale - 1, ready: false })

    await expectRefused(redial(store), 'not_ready')
  })
})

// Each lane on its own: the narrowed isolated path, then the all-rows path it falls back to.
describe('a host offline through a roll, while the replacement process boots', () => {
  it('leaves the region through the narrowed path when its own has no room', async () => {
    // Only the narrowed path crosses regions; the all-rows path keeps the pin and refuses.
    const { store, heartbeat, at, isolateForRoll } = await setup([SOURCE, OTHER_REGION])
    await isolateForRoll()
    await at(20_000)
    await heartbeat(SOURCE, { incarnation: NEW_INCARNATION, startedAt: 15_000, ready: false })

    expect(await hintedAssign(store)).toMatchObject({ cellId: OTHER_REGION.id })
  })

  it('moves through the all-rows path when the host holds units no lease backs', async () => {
    // Unbacked units make the narrowed path decline, so only the all-rows branch can move it.
    const { store, database, heartbeat, at, isolateForRoll } = await setup()
    await database.query(
      `UPDATE relay_assignments SET reserved_invites = 1 WHERE user_id = ? AND relay_host_id = ?`,
      [IDENTITY.userId, IDENTITY.relayHostId]
    )
    await isolateForRoll()
    await at(20_000)
    await heartbeat(SOURCE, { incarnation: NEW_INCARNATION, startedAt: 15_000, ready: false })

    expect(await hintedAssign(store)).toMatchObject({ cellId: TARGET.id })
  })
})
