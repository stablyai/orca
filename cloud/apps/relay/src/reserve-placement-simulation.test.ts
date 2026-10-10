import { describe, expect, it } from 'vitest'
import {
  runReservePlacementSimulation,
  type SimulationConfig,
  type SimulationReport
} from './reserve-placement-simulation.js'

const SEEDS = [11, 23, 47]
const rtt = (region: string) => (region === 'asia-east2' ? 170 : 10)

function fleet(): SimulationConfig['cells'] {
  const cells: SimulationConfig['cells'] = []
  for (let index = 0; index < 24; index += 1) {
    cells.push({
      cellId: `us${String(index).padStart(2, '0')}`,
      region: 'us-central1',
      hardCap: 600,
      ceiling: 480,
      intakePerSec: 5,
      // A third of the fleet stays in database mode, one cell on an image without step 5.
      mode: index % 3 === 0 ? 'db' : 'reserve',
      old: index === 0,
      preseated: 150
    })
  }
  for (let index = 0; index < 6; index += 1) {
    cells.push({
      cellId: `asia${index}`,
      region: 'asia-east2',
      hardCap: 600,
      ceiling: 480,
      intakePerSec: 2,
      mode: index === 0 ? 'db' : 'reserve',
      preseated: 200
    })
  }
  return cells
}

function expectInvariants(report: SimulationReport): void {
  expect(report.violations).toEqual([])
}

describe('step 5 deterministic simulation', () => {
  it.each(SEEDS)(
    'holds invariants 1-3 and 5-8 across mixed versions, lagging polls, restarts and database stalls (seed %i)',
    async (seed) => {
      const report = await runReservePlacementSimulation({
        seed,
        durationMs: 25 * 60_000,
        directors: 5,
        // One director still on the database-only revision.
        oldDirectors: 1,
        cells: fleet(),
        hosts: 6_600,
        hostRegion: (index) => (index % 5 === 0 ? 'asia-east2' : 'us-central1'),
        arrivalPerSec: 20,
        meanSessionMs: 8 * 60_000,
        reconnectDelayMs: [500, 5_000],
        duplicateAssignShare: 0.05,
        halfOpenShare: 0.05,
        pollLagMs: (director) => [0, 200, 1_000, 4_000, 10_000][director]!,
        rttMs: rtt,
        cellRestarts: [{ at: 6 * 60_000, cellId: 'us04' }, { at: 14 * 60_000, cellId: 'asia2' }],
        directorRestarts: [{ at: 8 * 60_000, director: 2 }, { at: 16 * 60_000, director: 4 }],
        // Drained hosts land elsewhere while their old seat lingers: placement supersedes it.
        drains: [{ at: 12 * 60_000, cellId: 'us05', paceMs: 60_000 }],
        databaseStalls: Array.from({ length: 3 }, (_, index) => ({
          at: (index * 610 + 120) * 1_000,
          durationMs: 7_000
        }))
      })
      expectInvariants(report)
      expect(report.reservePlacements).toBeGreaterThan(500)
      expect(report.stickyAnswers).toBeGreaterThan(500)
      expect(report.seatedAtEnd).toBeGreaterThan(4_000)
      // The run reached the paths the invariants guard, so a pass is not vacuous.
      expect(report.supersedes).toBeGreaterThan(0)
      expect(report.rowAheadDemotions).toBeGreaterThan(0)
      expect(report.directorRestarts).toBe(2)
      expect(report.stickyReserves).toBeGreaterThan(0)
      expect(report.databasePlacements).toBeGreaterThan(0)
    },
    120_000
  )

  it.each(SEEDS)(
    'near full: extra reserve calls stay within 10% and exhausted requests within 1% (seed %i)',
    async (seed) => {
      const cells = Array.from({ length: 17 }, (_, index) => ({
        cellId: `us${index}`,
        region: 'us-central1' as const,
        hardCap: 700,
        ceiling: 600,
        intakePerSec: 50,
        mode: 'reserve' as const,
        preseated: 582
      }))
      const report = await runReservePlacementSimulation({
        seed,
        durationMs: 3 * 60_000,
        directors: 5,
        cells,
        hosts: 17 * 582 + 300,
        hostRegion: () => 'us-central1',
        arrivalPerSec: 10,
        meanSessionMs: 0,
        reconnectDelayMs: [1_000, 3_000],
        duplicateAssignShare: 0,
        halfOpenShare: 0,
        pollLagMs: () => 0,
        rttMs: rtt
      })
      expectInvariants(report)
      expect(report.reservePlacements).toBeGreaterThan(250)
      expect(report.reserveCalls / report.reservePlacements - 1).toBeLessThanOrEqual(0.1)
      expect(report.exhausted / report.requests).toBeLessThanOrEqual(0.01)
      for (const share of Object.values(report.maxOccupancyShare)) expect(share).toBeLessThanOrEqual(1)
    },
    120_000
  )

  it.each(SEEDS.flatMap((seed) => [[1_200_000, seed], [300_000, seed]] as const))(
    'a drain onto an empty cell at the %i ms pace spreads within each cell intake budget (seed %i)',
    async (paceMs, seed) => {
      // The c27 shape: the drained cell's hosts move at the 1,200 s pace onto five cells
      // with free seats 2,805 / 841 / 777 / 667 / 26.
      const free = [2_805, 841, 777, 667, 26]
      const cells: SimulationConfig['cells'] = free.map((seats, index) => ({
        cellId: `asia${index + 1}`,
        region: 'asia-east2',
        hardCap: 3_000,
        ceiling: 2_830,
        intakePerSec: 2,
        mode: 'reserve',
        preseated: 2_830 - seats
      }))
      cells.unshift({
        cellId: 'asia0',
        region: 'asia-east2',
        hardCap: 3_000,
        ceiling: 2_830,
        intakePerSec: 2,
        mode: 'reserve',
        preseated: 2_770
      })
      const preseated = cells.reduce((sum, cell) => sum + (cell.preseated ?? 0), 0)
      const report = await runReservePlacementSimulation({
        seed,
        durationMs: 30 * 60_000,
        directors: 5,
        cells,
        hosts: preseated,
        hostRegion: () => 'asia-east2',
        arrivalPerSec: 1,
        meanSessionMs: 0,
        reconnectDelayMs: [1_000, 3_000],
        duplicateAssignShare: 0.02,
        halfOpenShare: 0,
        pollLagMs: () => 0,
        rttMs: rtt,
        drains: [{ at: 10_000, cellId: 'asia0', paceMs }]
      })
      expectInvariants(report)
      // Below every cell's budget nothing waits; above it the cells' buckets pace the drain.
      if (paceMs === 300_000) expect(report.intakeRefusals + report.paced).toBeGreaterThan(0)
      const moved = Object.entries(report.arrivalsByCell)
      const total = moved.reduce((sum, [, count]) => sum + count, 0)
      expect(total).toBeGreaterThan(2_000)
      // Spread: the emptiest cell takes a share, not the drain.
      expect((report.arrivalsByCell.asia1 ?? 0) / total).toBeLessThan(0.6)
      expect(moved.filter(([, count]) => count / total > 0.1).length).toBeGreaterThanOrEqual(3)
    },
    120_000
  )

  // Each fault breaks one rule; the matching invariant must fire, or its check measures nothing.
  const mixed = (faults: SimulationConfig['faults']): SimulationConfig => ({
    seed: 11,
    durationMs: 8 * 60_000,
    directors: 5,
    cells: fleet(),
    hosts: 6_600,
    hostRegion: (index) => (index % 5 === 0 ? 'asia-east2' : 'us-central1'),
    arrivalPerSec: 20,
    meanSessionMs: 4 * 60_000,
    reconnectDelayMs: [500, 5_000],
    duplicateAssignShare: 0.1,
    halfOpenShare: 0.1,
    pollLagMs: (director) => [0, 200, 1_000, 2_000, 3_000][director]!,
    rttMs: rtt,
    faults
  })
  const nearFull = (faults: SimulationConfig['faults']): SimulationConfig => ({
    ...mixed(faults),
    cells: Array.from({ length: 4 }, (_, index) => ({
      cellId: `us${index}`,
      region: 'us-central1' as const,
      hardCap: 600,
      ceiling: 600,
      intakePerSec: 500,
      mode: 'reserve' as const,
      preseated: 590
    })),
    hosts: 4 * 590 + 400,
    hostRegion: () => 'us-central1',
    arrivalPerSec: 400,
    meanSessionMs: 0
  })
  const drain = (faults: SimulationConfig['faults']): SimulationConfig => ({
    ...mixed(faults),
    cells: [0, 1, 2].map((index) => ({
      cellId: `asia${index}`,
      region: 'asia-east2' as const,
      hardCap: 3_000,
      ceiling: 2_800,
      intakePerSec: 2,
      mode: 'reserve' as const,
      preseated: index === 0 ? 1_000 : 100
    })),
    hosts: 1_200,
    hostRegion: () => 'asia-east2',
    meanSessionMs: 0,
    drains: [{ at: 10_000, cellId: 'asia0', paceMs: 60_000 }]
  })
  // The database stalls, the queue grows, and the director restarts before it drains.
  const drainedWithoutSupersede = (): SimulationConfig => ({
    ...mixed({ skipSupersede: true }),
    drains: [{ at: 60_000, cellId: 'us05', paceMs: 30_000 }]
  })
  // Long enough for two reconciles: a seat behind its row must not survive the second.
  const rowAheadLeftAlone = (): SimulationConfig => ({
    ...mixed({ noRowAheadDemote: true }),
    durationMs: 25 * 60_000,
    oldDirectors: 1
  })
  // Demote, re-assign, converge: a placement that never mints above the row is demoted again
  // and again behind the same row.
  const rowAheadNeverRises = (): SimulationConfig => ({
    ...mixed({ mintAtFloor: true }),
    durationMs: 25 * 60_000,
    oldDirectors: 1
  })
  const restartedMidQueue = (): SimulationConfig => ({
    ...mixed({ noBootReconcile: true }),
    durationMs: 2 * 60_000,
    databaseStalls: [{ at: 50_000, durationMs: 20_000 }],
    directorRestarts: [0, 1, 2, 3, 4].map((director) => ({ at: 65_000, director }))
  })
  it.each([
    [1, nearFull({ bookPastCap: true })],
    [2, drain({ intakeBurst: 200, directorShare: 0.05 })],
    [3, drainedWithoutSupersede()],
    [5, mixed({ unguardedLedger: true })],
    // A director restart mid-queue loses its booked joins' rows until its boot reconcile.
    [5, restartedMidQueue()],
    [8, rowAheadLeftAlone()],
    [8, rowAheadNeverRises()],
    [7, mixed({ noEpochFloor: true })]
  ] as const)('invariant %i fires when its rule is broken', async (invariant, config) => {
    const report = await runReservePlacementSimulation(config)
    expect(report.violations.map((violation) => violation.invariant)).toContain(invariant)
  }, 120_000)

  it('repairs a seat behind its row within two demotions, and reports re-seats that miss', async () => {
    const config = { ...mixed({}), durationMs: 25 * 60_000, oldDirectors: 1 }
    const report = await runReservePlacementSimulation(config)
    expect(report.rowAheadDemotions).toBeGreaterThan(0)
    expect(report.violations.filter((violation) => violation.invariant === 8)).toEqual([])
    expect(report.rowAheadDemotionsPerHost.max).toBeLessThanOrEqual(2)
    // A director whose map has not seen the leave yet may re-place level with the row; the
    // WRONG_CELL row read keeps that a small share (the rest are repaired by one more reconcile).
    expect(report.badFirstReseats / report.rowAheadDemotions).toBeLessThan(0.1)
    const withoutRead = await runReservePlacementSimulation({ ...config, faults: { noWrongCellRowRead: true } })
    process.stderr.write(
      `row_ahead_repair ${JSON.stringify({
        withRead: { demotions: report.rowAheadDemotions, badFirstReseats: report.badFirstReseats, perHost: report.rowAheadDemotionsPerHost },
        withoutRead: { demotions: withoutRead.rowAheadDemotions, badFirstReseats: withoutRead.badFirstReseats, perHost: withoutRead.rowAheadDemotionsPerHost }
      })}\n`
    )
  }, 240_000)

  // Every director misses its feed polls for 150 s: each reserve cell's dead-man trips (60-120 s)
  // while Postgres still says reserve, and fresh placement must find the tripped cells after.
  const fleetTrip = (faults: SimulationConfig['faults']): SimulationConfig => ({
    ...mixed(faults),
    cells: Array.from({ length: 6 }, (_, index) => ({
      cellId: `us${index}`,
      region: 'us-central1' as const,
      hardCap: 600,
      ceiling: 480,
      intakePerSec: 5,
      mode: 'reserve' as const,
      preseated: 100
    })),
    hosts: 1_200,
    hostRegion: () => 'us-central1',
    durationMs: 6 * 60_000,
    pollOutages: [{ at: 60_000, durationMs: 150_000 }]
  })

  // Token minting, the cells' token check or a partition: no director's poll gets through again.
  // The cells' own rows still say db once they trip, so today's path recovers without the feed;
  // before the trips a fully reserve region has no fresh placement (60-120 s).
  it('recovers fresh placement while feed polls fail and stay failed, once the cells trip (invariant 9)', async () => {
    const stuck = (faults: SimulationConfig['faults']) => ({
      ...fleetTrip(faults),
      pollOutages: [{ at: 60_000, durationMs: Number.POSITIVE_INFINITY }]
    })
    const report = await runReservePlacementSimulation(stuck({}))
    expect(report.deadManTrips).toBe(6)
    expect(report.violations.filter((violation) => violation.invariant === 9)).toEqual([])
    expect(report.databasePlacementsWhilePollsFail).toBeGreaterThan(0)
    // The first cell trips 60-120 s into the outage; its row is read within a few seconds.
    expect(report.pollFailureGapMs).toBeGreaterThanOrEqual(60_000)
    expect(report.pollFailureGapMs).toBeLessThanOrEqual(130_000)
    const blocked = await runReservePlacementSimulation(stuck({ pgReserveBlocksDatabase: true }))
    expect(blocked.violations.map((violation) => violation.invariant)).toContain(9)
  }, 240_000)

  // A tripped cell reports reserve while it re-registers, but db as its raw mode at once.
  it('books nothing on a tripped cell while it re-registers, by its raw mode', async () => {
    const slow = (faults: SimulationConfig['faults']) => ({ ...fleetTrip(faults), reregistrationMs: 120_000 })
    const report = await runReservePlacementSimulation(slow({}))
    expect(report.deadManTrips).toBe(6)
    expect(report.reserveCallsOnTrippedCells).toBe(0)
    const reported = await runReservePlacementSimulation(slow({ noRawFeedMode: true }))
    expect(reported.reserveCallsOnTrippedCells).toBeGreaterThan(0)
  }, 240_000)

  it('places fresh hosts on the tripped cells once a fleet-wide poll outage ends (invariant 9)', async () => {
    const report = await runReservePlacementSimulation(fleetTrip({}))
    expect(report.deadManTrips).toBe(6)
    expect(report.violations.filter((violation) => violation.invariant === 9)).toEqual([])
    expect(report.databasePlacements).toBeGreaterThan(0)
    const blocked = await runReservePlacementSimulation(fleetTrip({ pgReserveBlocksDatabase: true }))
    expect(blocked.deadManTrips).toBe(6)
    expect(blocked.violations.map((violation) => violation.invariant)).toContain(9)
  }, 240_000)
})
