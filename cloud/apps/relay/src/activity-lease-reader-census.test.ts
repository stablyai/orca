import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayCellConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'

// Step 6 (design §3.5): a phone on a `phonePath=memory` cell writes no `confirmation:` or
// `splice:` lease. Every reader of the lease table is classified by why that is safe; a new
// reader fails this test until someone decides. While the cell is recorded as reserve its
// control holds no lease either, so step 5's guards already cover it; after a flip back a
// memory phone looks like today's phone once its 90 s lease has expired.
const ACTIVITY_LEASE_READERS: Record<string, string> = {
  // Reads control leases only, so phone leases never change the answer.
  'assignment-store.ts:activateControlOnce': 'control-only',
  'assignment-store.ts:reconcileIdleRegionalRehome': 'control-only',
  'assignment-store.ts:renewTransactionalControlActivity': 'control-only',
  'assignment-store.ts:startRegionalRehomeCandidate': 'control-only',
  'control-renewal-statement.ts:CONTROL_RENEWAL_BATCH_SQL': 'control-only',
  'idle-regional-rehome-selection.ts:selectIdleRegionalRehomes': 'control-only',
  // Refuses or skips a cell recorded as reserve (or an unreadable set).
  'assignment-store.ts:cellDeploymentStatus': 'refuses-or-skips-reserve-cells',
  'assignment-store.ts:cellEvacuationCapacity': 'refuses-or-skips-reserve-cells',
  'assignment-store.ts:releaseExpiredActivity': 'refuses-or-skips-reserve-cells',
  'assignment-store.ts:releaseExpiredActivityLeases': 'refuses-or-skips-reserve-cells',
  'assignment-store.ts:startEvacuation': 'refuses-or-skips-reserve-cells',
  // Its only caller drops candidates whose source or target is a reserve cell.
  'idle-regional-rehome-selection.ts:sourceRequestUnits': 'refuses-or-skips-reserve-cells',
  // Only hosts in an open drain, migration or rehome, which no reserve cell can have:
  // setCellAdmitMode refuses reserve while one is open, and every start refuses a reserve cell.
  'assignment-store.ts:activeCellMigrations': 'open-flow-only',
  'assignment-store.ts:additionalActivityCellIds': 'open-flow-only',
  'assignment-store.ts:assertCellReservationAccounting': 'open-flow-only',
  'assignment-store.ts:beginCellDrainSend': 'open-flow-only',
  'assignment-store.ts:beginCellDrainSendOnce': 'open-flow-only',
  'assignment-store.ts:completeReadyEvacuations': 'open-flow-only',
  'assignment-store.ts:completeReadyRegionalRehomes': 'open-flow-only',
  'assignment-store.ts:reconcileDrainMigrationAccounting': 'open-flow-only',
  'assignment-store.ts:reconcileReservationAccounting': 'open-flow-only',
  'assignment-store.ts:refreshDrainMigrationLeasesOnce': 'open-flow-only',
  'registered-migration-abandonment.ts:ABANDONED_REGISTERED_MIGRATION': 'open-flow-only',
  // One host's rows under lock; each caller is classified in the reserve-mode census.
  'assignment-store.ts:lockAssignmentActivities': 'host-lock',
  // Metrics and previews: they report, and act on nothing.
  'assignment-inventory-snapshot.ts:readAssignmentInventorySnapshot': 'report-only',
  'region-correction-preview.ts:previewRegionalRehomeEligibility': 'report-only',
  'registered-migration-inventory.ts:readRegisteredMigrationInventory': 'report-only',
  // Step 5's existing-only stranded release, fixed separately in #30609 before the first flip.
  'assignment-store.ts:assignmentStrandedOnUnservedCell': 'step-5-stranded-release'
}

// A read is FROM, JOIN or USING on the table; `DELETE FROM` alone only writes. Not caught: a
// second read inside an already listed function, and counters derived from leases elsewhere.
const LEASE_TABLE = 'relay_assignment_activity_leases'
// Bare table-name values that never reach SQL.
const BARE_TABLE_NAME_USES: Record<string, string> = {
  'database.ts:POSTGRES_TRANSACTION_PHASES': 'labels a failed statement by the table it names'
}
const LEASE_READ = /(?<!DELETE\s+)\b(?:FROM|JOIN|USING)\s+relay_assignment_activity_leases\b/

const CELLS: RelayCellConfig[] = [
  { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
  { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
]

describe('activity-lease reader census', () => {
  let database: RelayDatabase | undefined

  afterEach(async () => {
    await database?.close()
    database = undefined
  })

  it('classifies every reader of the activity-lease table', () => {
    const { readers, bareTableNames } = activityLeaseReaders()
    // A bare name could reach `FROM ${table}`, which the scan cannot see: write the table into the SQL.
    expect(bareTableNames.filter((use) => !(use in BARE_TABLE_NAME_USES))).toEqual([])
    expect(readers.filter((name) => !(name in ACTIVITY_LEASE_READERS))).toEqual([])
    expect(Object.keys(ACTIVITY_LEASE_READERS).filter((name) => !readers.includes(name))).toEqual([])
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

  it('refuses evacuation status for a reserve cell, where activeCellMigrations would count no units', async () => {
    const store = await setup(() => 1_000)
    await store.setCellAdmitMode('cell-a', 'reserve')
    await expect(store.cellEvacuationStatus('cell-a', 'cell-b', true)).rejects.toThrow(
      'cell_in_reserve_mode'
    )
    await expect(store.cellEvacuationStatus('cell-b', 'cell-a', false)).rejects.toThrow(
      'cell_in_reserve_mode'
    )
  })
})

function activityLeaseReaders(): { readers: string[]; bareTableNames: string[] } {
  const directory = fileURLToPath(new URL('.', import.meta.url))
  const readers = new Set<string>()
  const bareTableNames: string[] = []
  const files = readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter(
    (file) => file.endsWith('.ts') && !file.includes('.test.') && !file.split(/[\\/]/).includes('test-fixtures')
  )
  for (const file of files) {
    const text = readFileSync(join(directory, file), 'utf8')
    if (!text.includes(LEASE_TABLE)) continue
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
    const visit = (node: ts.Node): void => {
      if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isStringLiteral(node)) {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.trim() === LEASE_TABLE) {
          bareTableNames.push(`${file}:${enclosingName(node)}`)
        }
        if (LEASE_READ.test(node.getText())) {
          readers.add(`${file}:${enclosingName(node)}`)
          return
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { readers: [...readers].sort(), bareTableNames }
}

function enclosingName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) && current.name) {
      return current.name.getText()
    }
    // A module-level SQL constant, never a local `const rows = ...` inside a method.
    if (ts.isVariableStatement(current) && ts.isSourceFile(current.parent)) {
      return current.declarationList.declarations.map((declaration) => declaration.name.getText()).join(',')
    }
  }
  return '<module>'
}
