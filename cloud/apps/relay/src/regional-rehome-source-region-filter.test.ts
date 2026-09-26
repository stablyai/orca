import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { rehomeSourceRegionAllowed } from './idle-regional-rehome-selection.js'
import { openIdleRehomeTestDatabase } from './idle-regional-rehome-test-database.js'
import { REGIONAL_REHOME_POLL_SUMMARY_INTERVAL_MS } from './regional-rehome-poll-telemetry.js'

type Region = 'us-central1' | 'asia-east2'
const cell = (id: string, region: Region) => ({
  id,
  url: `https://${id}.relay.example.test`,
  region,
  capacityRequests: 100,
  connectionHardCap: 1_000 as const,
  connectionUnobservedBound: 60
})
const usA = cell('us-a', 'us-central1')
const usB = cell('us-b', 'us-central1')
const asiaA = cell('asia-a', 'asia-east2')
const asiaB = cell('asia-b', 'asia-east2')
const cells = [usA, usB, asiaA, asiaB]
const usHost = { userId: 'user-us', relayHostId: 'usususususususus' }
const asiaHost = { userId: 'user-asia', relayHostId: 'asiaasiaasiaasia' }

const incarnation = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}` +
  `-8${String(n).repeat(3)}-${String(n).repeat(12)}`

async function setup(directorRegion: Region | undefined) {
  let clock = 1_000_000
  const database = await openIdleRehomeTestDatabase()
  const store = new RelayAssignmentStore(database, () => clock, {
    regionalRehomeCohortPercent: 100,
    regionalRehomeDirectorRegion: directorRegion,
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
    hostCooldownMs: 7 * 24 * 60 * 60_000,
    drainGraceMs: 60 * 60_000
  })
  await store.reconcileCells(cells)
  const safety = () => ({
    observedAt: clock,
    sqlFailures: 0,
    reconnects: 0,
    controlActivityRecoveryFailures: 0,
    databasePoolWaiting: 0,
    databasePoolWaitersMax: 0,
    databasePoolWaitMsMax: 0
  })
  const beatAll = async () => {
    for (const [index, config] of cells.entries()) {
      await store.recordCellHeartbeat({
        cellId: config.id,
        cellUrl: config.url,
        region: config.region,
        cellIncarnation: incarnation(index + 1),
        startedAt: 900_000,
        ready: true,
        observedRequests: 0,
        totalConnections: 0,
        inFlightConnections: 0,
        reservedConnectionUnits: 0,
        enforcedConnectionUnits: 0,
        connectionInclusionWatermark: clock,
        connectionHardCap: 1_000,
        connectionUnobservedBound: 60
      })
      await store.recordCellRegionalRehomeStatus({
        cellId: config.id,
        cellIncarnation: incarnation(index + 1),
        regionalRehomeProtocol: 3,
        safety: safety()
      })
    }
  }
  // Homes the host in `home` with a conclusive measurement preferring the other region.
  const placeHost = async (identity: { userId: string; relayHostId: string }, home: Region) => {
    const assignment = await store.assign(identity, undefined, home)
    const homeCell = cells.find(({ id }) => id === assignment.cellId)!
    expect(homeCell.region).toBe(home)
    await store.activateControl(identity, {
      cellId: assignment.cellId,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1,
      idleRegionalRehome: true,
      cellIncarnation: incarnation(cells.indexOf(homeCell) + 1)
    })
    const { window } = await store.exchangeRegionCorrection(
      identity,
      { v: 1, action: 'issue-window' },
      assignment.assignmentEpoch
    )
    expect(window).toBeDefined()
    await store.exchangeRegionCorrection(
      identity,
      {
        v: 1,
        action: 'report',
        generation: window!.generation,
        assignmentEpoch: assignment.assignmentEpoch,
        policyVersion: 1,
        outcome: 'conclusive',
        measurements:
          home === 'us-central1'
            ? { 'us-central1': 180, 'asia-east2': 40 }
            : { 'us-central1': 40, 'asia-east2': 180 }
      },
      assignment.assignmentEpoch
    )
  }
  await beatAll()
  await placeHost(usHost, 'us-central1')
  await placeHost(asiaHost, 'asia-east2')
  return {
    database,
    store,
    safety,
    beatAll,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

const moves = (candidates: { userId: string; sourceCellId: string; targetCellId: string }[]) =>
  candidates.map(({ userId, sourceCellId, targetCellId }) => ({
    userId,
    from: cells.find(({ id }) => id === sourceCellId)!.region,
    to: cells.find(({ id }) => id === targetCellId)!.region
  }))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rehome source-region filter', () => {
  it('keys on the source region, never on the target region', () => {
    expect(rehomeSourceRegionAllowed('us-central1', 'us-central1')).toBe(true)
    expect(rehomeSourceRegionAllowed('asia-east2', 'us-central1')).toBe(false)
    expect(rehomeSourceRegionAllowed('asia-east2', undefined)).toBe(true)
  })

  it('keeps US to Asia moves and drops Asia to US moves', async () => {
    const context = await setup('us-central1')
    const candidates = await context.store.selectIdleRegionalRehomeCandidates(context.safety())
    // Asia is filtered as a source yet is still every US host's target.
    expect(new Set(moves(candidates).map((move) => JSON.stringify(move)))).toEqual(
      new Set([JSON.stringify({ userId: usHost.userId, from: 'us-central1', to: 'asia-east2' })])
    )
    expect(new Set(candidates.map(({ targetCellId }) => targetCellId))).toEqual(
      new Set([asiaA.id, asiaB.id])
    )
    await context.database.close()
  })

  it('selects both directions when no director region is configured', async () => {
    const context = await setup(undefined)
    const candidates = await context.store.selectIdleRegionalRehomeCandidates(context.safety())
    expect(new Set(moves(candidates).map(({ from, to }) => `${from}>${to}`))).toEqual(
      new Set(['us-central1>asia-east2', 'asia-east2>us-central1'])
    )
    await context.database.close()
  })

  it('counts the skipped source cells in the poll summary line', async () => {
    const context = await setup('us-central1')
    const lines: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    await context.store.selectIdleRegionalRehomeCandidates(context.safety())
    context.advance(REGIONAL_REHOME_POLL_SUMMARY_INTERVAL_MS)
    await context.beatAll()
    await context.store.selectIdleRegionalRehomeCandidates(context.safety())
    const summary = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find(({ event }) => event === 'orca_relay_regional_rehome_poll_summary')
    expect(summary).toMatchObject({ open: 2, skippedOffRegionSourceCells: 2 })
    await context.database.close()
  })

  it('reports the filtered hosts in the preview, agreeing with selection', async () => {
    const context = await setup('us-central1')
    const preview = await context.store.previewRegionalRehomeEligibility(context.safety())
    expect(preview.counts).toEqual({
      'eligible:us-central1-to-asia-east2': 1,
      'source-outside-director-region': 1
    })
    await context.database.close()
  })
})
