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
  // A reserve source keeps no activity rows, so its "no source units" check proves nothing.
  completeEvacuation: 'refuses-reserve-cells',
  completeEvacuationFromDeadSource: 'refuses-reserve-cells',
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
  cellAdmitMode: 'cell-level',
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
  reserveModeCells: 'cell-level',
  recordCellFenceOperation: 'cell-level',
  recordCellHeartbeat: 'cell-level',
  recordCellRegionalRehomeStatus: 'cell-level',
  regionCatalog: 'cell-level',
  regionCorrectionOutcomes: 'cell-level',
  regionalRehomeFleetSafety: 'cell-level',
  releaseExpiredRegionPreferences: 'cell-level',
  seatFeedCells: 'cell-level',
  setCellAdmissionState: 'cell-level',
  setCellAdmitMode: 'cell-level',
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

  async function setup(now: () => number, reserve: string[] = []) {
    database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, now)
    await store.reconcileCells(CELLS)
    await setReserve(store, reserve)
    return store
  }

  async function setReserve(store: RelayAssignmentStore, reserve: string[]) {
    for (const cell of CELLS) {
      await store.setCellAdmitMode(cell.id, reserve.includes(cell.id) ? 'reserve' : 'db')
    }
  }

  // A store that has never read the set: the table is unreadable.
  async function unknownSet(now: () => number) {
    const unknown = new RelayAssignmentStore(database!, now)
    await database!.query('ALTER TABLE relay_cell_admit_modes RENAME TO relay_cell_admit_modes_gone')
    return {
      unknown,
      restore: async () =>
        await database!.query('ALTER TABLE relay_cell_admit_modes_gone RENAME TO relay_cell_admit_modes')
    }
  }

  it('lets no expiry sweep touch a reserve-mode cell, and runs none while the set is unknown', async () => {
    let now = 1_000
    const store = await setup(() => now)
    const onA = { userId: 'user-a', relayHostId: 'host000000000001' }
    expect((await store.assign(onA)).cellId).toBe('cell-a')
    await store.acquireActivity(onA, { activityId: 'invite:one', kind: 'invite', cellId: 'cell-a' })
    await setReserve(store, ['cell-a'])
    now += ASSIGNMENT_LIMITS.activityLeaseMs + 1
    expect(await store.releaseExpiredActivityLeases()).toBe(0)
    expect(await store.releaseExpiredActivity()).toBe(0)
    const { unknown, restore } = await unknownSet(() => now)
    expect(await unknown.reserveModeCells()).toBeNull()
    expect(await unknown.releaseExpiredActivityLeases()).toBe(0)
    expect(await unknown.evacuateDeadCells()).toBe(0)
    await restore()
    await setReserve(store, [])
    expect(await store.releaseExpiredActivityLeases()).toBeGreaterThan(0)
  })

  it('keeps an idle host sticky on a reserve-mode cell where today it would be re-placed', async () => {
    let now = 1_000
    const store = await setup(() => now)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.changeActivity(identity, 'control', -1)
    now += ASSIGNMENT_LIMITS.activityLeaseMs + ASSIGNMENT_LIMITS.dormantTtlMs + 1
    await setReserve(store, [first.cellId])
    expect(await store.assign(identity)).toMatchObject({
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch
    })
    // Not knowing which cells are switched on is treated the same way.
    const { unknown, restore } = await unknownSet(() => now)
    expect((await unknown.assign(identity)).assignmentEpoch).toBe(first.assignmentEpoch)
    await restore()
  })

  it('never places a fresh host on a reserve-mode cell through the database', async () => {
    const store = await setup(() => 1_000, ['cell-a'])
    for (let index = 0; index < 4; index += 1) {
      const placed = await store.assign({
        userId: `user-${index}`,
        relayHostId: `host${String(index).padStart(12, '0')}`
      })
      expect(placed.cellId).toBe('cell-b')
    }
  })

  it('refuses drains, evacuations and status reads that would treat a reserve-mode cell as empty', async () => {
    const store = await setup(() => 1_000, ['cell-a'])
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
    // Unknown refuses too, with a retryable error.
    const { unknown, restore } = await unknownSet(() => 1_000)
    await expect(unknown.cellDeploymentStatus('cell-b')).rejects.toThrow('reserve_mode_unknown')
    await restore()
  })

  it('refuses the flip to reserve while a migration names the cell', async () => {
    const store = await setup(() => 1_000)
    await database!.query(
      `INSERT INTO relay_assignment_migrations
       (user_id, relay_host_id, source_cell_id, target_cell_id, previous_epoch, assignment_epoch,
        source_request_units, target_reserved_units, expires_at, created_at, updated_at)
       VALUES ('user-a', 'host000000000001', 'cell-b', 'cell-a', 1, 2, 0, 1, 9999, 1000, 1000)`
    )
    await expect(store.setCellAdmitMode('cell-a', 'reserve')).rejects.toThrow('cell_has_open_migration')
    expect(await store.cellAdmitMode('cell-a')).toMatchObject({ admitMode: 'db' })
    await store.setCellAdmitMode('cell-a', 'db')
    await database!.query(`UPDATE relay_assignment_migrations SET aborted_at = 1001`)
    await store.setCellAdmitMode('cell-a', 'reserve')
    expect(await store.cellAdmitMode('cell-a')).toMatchObject({ admitMode: 'reserve', updatedAt: 1_000 })
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
