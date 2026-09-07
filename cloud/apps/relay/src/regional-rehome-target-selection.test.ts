import { describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openInMemoryRelayDatabase } from './database.js'
import { REGIONAL_REHOME_SQL_FAILURES_PER_CELL_LIMIT } from './regional-rehome-safety.js'

const cell = (id: string, region: 'us-central1' | 'asia-east2') => ({
  id,
  url: `https://${id}.relay.example.test`,
  region,
  capacityRequests: 100,
  connectionHardCap: 1_000 as const,
  connectionUnobservedBound: 60
})
const source = cell('us-c1', 'us-central1')
const noHeadroom = cell('asia-a', 'asia-east2')
const unclean = cell('asia-b', 'asia-east2')
const highLoad = cell('asia-c', 'asia-east2')
const lowLoad = cell('asia-d', 'asia-east2')

const incarnation = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}` +
  `-8${String(n).repeat(3)}-${String(n).repeat(12)}`

async function setup() {
  let clock = 1_000_000
  const database = await openInMemoryRelayDatabase()
  const store = new RelayAssignmentStore(database, () => clock, {
    requireLiveCells: true,
    heartbeatTtlMs: 45_000
  })
  await store.inspectRegionalRehomeControl()
  clock += 24 * 60 * 60_000
  await store.applyRegionalRehomeControl({
    expectedGeneration: 0,
    enabled: true,
    notBefore: clock,
    ratePerMinute: 10,
    preferenceMaxAgeMs: 24 * 60 * 60_000,
    drainGraceMs: 60 * 60_000
  })
  await store.reconcileCells([source, noHeadroom, unclean, highLoad, lowLoad])
  const beat = async (
    config: typeof source,
    n: number,
    protocol: number,
    state: { observedRequests: number; enforcedConnections: number; sqlFailures: number }
  ) => {
    await store.recordCellHeartbeat({
      cellId: config.id,
      cellUrl: config.url,
      region: config.region,
      cellIncarnation: incarnation(n),
      startedAt: 900_000,
      ready: true,
      observedRequests: state.observedRequests,
      totalConnections: state.enforcedConnections,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: state.enforcedConnections,
      connectionInclusionWatermark: clock,
      connectionHardCap: 1_000,
      connectionUnobservedBound: 60
    })
    await store.recordCellRegionalRehomeStatus({
      cellId: config.id,
      cellIncarnation: incarnation(n),
      regionalRehomeProtocol: protocol,
      safety: {
        observedAt: clock,
        sqlFailures: state.sqlFailures,
        reconnects: 0,
        controlActivityRecoveryFailures: 0,
        databasePoolWaiting: 0,
        databasePoolWaitersMax: 0,
        databasePoolWaitMsMax: 0
      }
    })
  }
  const activatePreferredSource = async () => {
    const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    const assignment = await store.assign(identity, undefined, 'us-central1')
    await store.activateControl(identity, {
      cellId: source.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    await store.assign(identity, 'asia-east2')
  }
  return { database, store, beat, activatePreferredSource }
}

const UNCLEAN = REGIONAL_REHOME_SQL_FAILURES_PER_CELL_LIMIT + 1

describe('regional rehome target selection', () => {
  it('never selects a target without connection headroom, even at lowest load', async () => {
    const context = await setup()
    await context.beat(source, 1, 1, {
      observedRequests: 0,
      enforcedConnections: 0,
      sqlFailures: 0
    })
    // Lowest load but the connection hard cap is exhausted.
    await context.beat(noHeadroom, 2, 0, {
      observedRequests: 0,
      enforcedConnections: 999,
      sqlFailures: 0
    })
    await context.beat(unclean, 3, 0, {
      observedRequests: 0,
      enforcedConnections: 0,
      sqlFailures: UNCLEAN
    })
    await context.beat(highLoad, 4, 0, {
      observedRequests: 50,
      enforcedConnections: 0,
      sqlFailures: 0
    })
    await context.beat(lowLoad, 5, 0, {
      observedRequests: 10,
      enforcedConnections: 0,
      sqlFailures: 0
    })
    await context.activatePreferredSource()

    const attempt = await context.store.claimRegionalRehome()
    expect(attempt?.targetCellId).toBe(lowLoad.id)
    await context.database.close()
  })

  it('falls to the next clean target when the load winner goes unclean', async () => {
    const context = await setup()
    await context.beat(source, 1, 1, {
      observedRequests: 0,
      enforcedConnections: 0,
      sqlFailures: 0
    })
    await context.beat(noHeadroom, 2, 0, {
      observedRequests: 0,
      enforcedConnections: 999,
      sqlFailures: 0
    })
    await context.beat(unclean, 3, 0, {
      observedRequests: 0,
      enforcedConnections: 0,
      sqlFailures: UNCLEAN
    })
    await context.beat(highLoad, 4, 0, {
      observedRequests: 50,
      enforcedConnections: 0,
      sqlFailures: 0
    })
    await context.beat(lowLoad, 5, 0, {
      observedRequests: 10,
      enforcedConnections: 0,
      sqlFailures: UNCLEAN
    })
    await context.activatePreferredSource()

    const attempt = await context.store.claimRegionalRehome()
    expect(attempt?.targetCellId).toBe(highLoad.id)
    await context.database.close()
  })
})
