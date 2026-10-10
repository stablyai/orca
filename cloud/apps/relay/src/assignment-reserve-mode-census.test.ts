import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore, RelayCellInReserveModeError } from './assignment-store.js'
import type { RelayCellConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'

// Step 5 census (design §6.3): a reserve-mode cell keeps its hosts in memory, so Postgres's
// per-host state for it is stale. Every store method is classified below; a new one fails
// this test until someone decides how it treats a reserve-mode cell.
const RESERVE_MODE_CENSUS: Record<string, string> = {
  // One host's connect, resolve or lease: a reserve-mode cell answers these from memory, and
  // its ledger row is written after the fact.
  acquireActivity: 'connect-path',
  activateControl: 'connect-path',
  assign: 'connect-path',
  changeActivity: 'connect-path',
  exchangeRegionCorrection: 'connect-path',
  hostWhereabouts: 'connect-path',
  markMigrationTargetRegistered: 'connect-path',
  releaseActivity: 'connect-path',
  renewControlActivities: 'connect-path',
  renewControlActivity: 'connect-path',
  resolve: 'connect-path',
  verifyCellAssignment: 'connect-path',
  // Sweeps and per-cell host readers: skip reserve-mode cells, or refuse them.
  cellDeploymentStatus: 'refuses-reserve-cells',
  cellEvacuationCapacity: 'refuses-reserve-cells',
  cellEvacuationStatus: 'refuses-reserve-cells',
  evacuateDeadCells: 'skips-reserve-cells',
  prepareCellDrainAttempt: 'refuses-reserve-cells',
  rebalanceDormant: 'refuses-reserve-cells',
  releaseExpiredActivity: 'skips-reserve-cells',
  releaseExpiredActivityLeases: 'skips-reserve-cells',
  selectIdleRegionalRehomeCandidates: 'skips-reserve-cells',
  startActiveCellEvacuations: 'refuses-reserve-cells',
  startEvacuation: 'refuses-reserve-cells',
  // Steps of a drain, migration or rehome that only exist once a refused start above began one.
  abortExpiredEvacuations: 'follows-a-refused-start',
  abortExpiredRegionalRehomes: 'follows-a-refused-start',
  abortUnarrivedRegionalRehomes: 'follows-a-refused-start',
  beginCellDrainSend: 'follows-a-refused-start',
  commitIdleRegionalRehome: 'follows-a-refused-start',
  completeEvacuation: 'follows-a-refused-start',
  completeEvacuationFromDeadSource: 'follows-a-refused-start',
  completeReadyEvacuations: 'follows-a-refused-start',
  completeReadyRegionalRehomes: 'follows-a-refused-start',
  prepareCellDrainRecovery: 'follows-a-refused-start',
  proveCellDrainNotDelivered: 'follows-a-refused-start',
  reapRegionalRehomeAttempts: 'follows-a-refused-start',
  reconcileIdleRegionalRehome: 'follows-a-refused-start',
  recordCellDrainApplicationReceipt: 'follows-a-refused-start',
  refreshRegionalRehomeLeases: 'follows-a-refused-start',
  supersedeRegisteredCellEvacuations: 'follows-a-refused-start',
  supersedeRegisteredEvacuation: 'follows-a-refused-start',
  // Cell-level state, fences and controls: no per-host rows.
  abortCellFenceAttempt: 'cell-level',
  addMigrationCells: 'cell-level',
  adoptLegacyCellFence: 'cell-level',
  applyCellAdmissionSelector: 'cell-level',
  applyRegionalRehomeControl: 'cell-level',
  attestCellFence: 'cell-level',
  attestCellFenceAttempt: 'cell-level',
  bindCellFencePlanGeneration: 'cell-level',
  cellFenceAttempt: 'cell-level',
  commitLegacyCellFenceAdoption: 'cell-level',
  configureCell: 'cell-level',
  disableRegionalRehomeControl: 'cell-level',
  inspectCellAdmissionSelector: 'cell-level',
  inspectRegionalRehomeControl: 'cell-level',
  prepareCellFenceAttempt: 'cell-level',
  previewRegionCorrection: 'cell-level',
  previewRegionalRehomeEligibility: 'cell-level',
  pruneReleasedControlReservations: 'cell-level',
  reconcileCells: 'cell-level',
  reconcileCellsAtStartup: 'cell-level',
  recordCellFenceOperation: 'cell-level',
  recordCellHeartbeat: 'cell-level',
  recordCellRegionalRehomeStatus: 'cell-level',
  regionCatalog: 'cell-level',
  regionCorrectionOutcomes: 'cell-level',
  regionalRehomeFleetSafety: 'cell-level',
  releaseExpiredRegionPreferences: 'cell-level',
  seatFeedCells: 'cell-level',
  setCellAdmissionState: 'cell-level',
  setCellEnabled: 'cell-level',
  startCellFenceApply: 'cell-level'
}

const CELLS: RelayCellConfig[] = [
  { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
  { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
]

describe('reserve-mode census', () => {
  let database: RelayDatabase | undefined

  afterEach(async () => {
    await database?.close()
    database = undefined
  })

  it('classifies every public store method for reserve-mode cells', () => {
    const methods = publicStoreMethods()
    expect(methods.filter((name) => !(name in RESERVE_MODE_CENSUS))).toEqual([])
    expect(Object.keys(RESERVE_MODE_CENSUS).filter((name) => !methods.includes(name))).toEqual([])
  })

  async function setup(now: () => number, reserve: () => ReadonlySet<string> | null) {
    database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, now, { reserveModeCells: reserve })
    await store.reconcileCells(CELLS)
    return store
  }

  it('lets no expiry sweep touch a reserve-mode cell, and runs none while the set is unknown', async () => {
    let now = 1_000
    let reserve: ReadonlySet<string> | null = new Set(['cell-a'])
    const store = await setup(() => now, () => reserve)
    const onA = { userId: 'user-a', relayHostId: 'host000000000001' }
    reserve = new Set()
    expect((await store.assign(onA)).cellId).toBe('cell-a')
    await store.acquireActivity(onA, { activityId: 'invite:one', kind: 'invite', cellId: 'cell-a' })
    reserve = new Set(['cell-a'])
    now += ASSIGNMENT_LIMITS.activityLeaseMs + 1
    expect(await store.releaseExpiredActivityLeases()).toBe(0)
    expect(await store.releaseExpiredActivity()).toBe(0)
    reserve = null
    expect(await store.releaseExpiredActivityLeases()).toBe(0)
    reserve = new Set()
    expect(await store.releaseExpiredActivityLeases()).toBeGreaterThan(0)
  })

  it('keeps an idle host sticky on a reserve-mode cell where today it would be re-placed', async () => {
    let now = 1_000
    let reserve: ReadonlySet<string> | null = new Set()
    const store = await setup(() => now, () => reserve)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.changeActivity(identity, 'control', -1)
    now += ASSIGNMENT_LIMITS.activityLeaseMs + ASSIGNMENT_LIMITS.dormantTtlMs + 1
    reserve = new Set([first.cellId])
    expect(await store.assign(identity)).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })
    // Not yet knowing which cells are switched on is treated the same way.
    reserve = null
    expect((await store.assign(identity)).assignmentEpoch).toBe(first.assignmentEpoch)
  })

  it('never places a fresh host on a reserve-mode cell through the database', async () => {
    const store = await setup(() => 1_000, () => new Set(['cell-a']))
    for (let index = 0; index < 4; index += 1) {
      const placed = await store.assign({
        userId: `user-${index}`,
        relayHostId: `host${String(index).padStart(12, '0')}`
      })
      expect(placed.cellId).toBe('cell-b')
    }
  })

  it('refuses drains, evacuations and status reads that would treat a reserve-mode cell as empty', async () => {
    const store = await setup(() => 1_000, () => new Set(['cell-a']))
    await expect(store.cellDeploymentStatus('cell-a')).rejects.toBeInstanceOf(
      RelayCellInReserveModeError
    )
    await expect(store.cellEvacuationCapacity('cell-a', 'cell-b')).rejects.toThrow(
      'cell_in_reserve_mode'
    )
    await expect(store.startActiveCellEvacuations('cell-b', 'cell-a', 10)).rejects.toThrow(
      'cell_in_reserve_mode'
    )
    await expect(
      store.prepareCellDrainAttempt({
        attemptId: '22222222-2222-4222-8222-222222222222',
        cellId: 'cell-a',
        cellIncarnation: '11111111-1111-4111-8111-111111111111',
        traceValue: 'trace',
        plannedGraceMs: 1_000
      })
    ).rejects.toThrow('cell_in_reserve_mode')
    expect((await store.cellDeploymentStatus('cell-b')).cellId).toBe('cell-b')
  })
})

function publicStoreMethods(): string[] {
  const path = fileURLToPath(new URL('./assignment-store.ts', import.meta.url))
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true)
  const names = new Set<string>()
  source.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== 'RelayAssignmentStore') return
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue
      const hidden = ts
        .getModifiers(member)
        ?.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.PrivateKeyword ||
            modifier.kind === ts.SyntaxKind.ProtectedKeyword
        )
      if (!hidden) names.add(member.name.text)
    }
  })
  return [...names].sort()
}
