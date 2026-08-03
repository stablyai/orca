import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import SyncDatabase from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

const LEGACY_COORDINATOR_HANDLE = 'term_legacy_coord'
const LEGACY_COORDINATOR_PANE = 'tab_coord:44444444-4444-4444-8444-444444444444'
const LEGACY_WORKER_HANDLE = 'term_legacy_worker'
const LEGACY_WORKER_PANE = 'tab_worker:33333333-3333-4333-8333-333333333333'
const CURRENT_COORDINATOR_HANDLE = 'term_current_coord'
const CURRENT_COORDINATOR_PANE = 'tab_current:11111111-1111-4111-8111-111111111111'

const tempDirs: string[] = []
const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function track(db: OrchestrationDb): OrchestrationDb {
  databases.push(db)
  return db
}

type AdoptedFixture = {
  db: OrchestrationDb
  adoptedRunId: string
  taskId: string
  dispatchId: string
  recoveryMessageId: string
}

/** Builds a pre-cutover graph at schema 18 and reopens it so adoption runs. */
function createAdoptedFixture(options: { settleWork: boolean }): AdoptedFixture {
  const dir = mkdtempSync(join(tmpdir(), 'orca-adopted-bind-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'orchestration.db')

  const before = new OrchestrationDb(dbPath)
  const task = before.createTask({
    spec: 'legacy assignment',
    createdByTerminalHandle: LEGACY_COORDINATOR_HANDLE
  })
  const dispatch = before.createDispatchContext(task.id, LEGACY_WORKER_HANDLE, LEGACY_WORKER_PANE)
  const recovery = before.insertMessage({
    from: LEGACY_WORKER_HANDLE,
    to: LEGACY_COORDINATOR_HANDLE,
    subject: 'recovered worker outcome',
    type: 'worker_done'
  })
  before.close()

  const raw = new SyncDatabase(dbPath)
  if (options.settleWork) {
    raw.exec("UPDATE dispatch_contexts SET status = 'completed'")
  }
  raw.exec(`
    DROP INDEX IF EXISTS idx_messages_delivery_contract;
    DROP TABLE legacy_mail_receipts;
    DROP TABLE legacy_operation_receipts;
    DROP TABLE legacy_compatibility_principals;
    DROP TABLE legacy_adoptions;
  `)
  raw.pragma('user_version = 18')
  raw.close()

  const db = track(new OrchestrationDb(dbPath))
  return {
    db,
    adoptedRunId: db.getLegacyAdoption()?.adopted_run_id as string,
    taskId: task.id,
    dispatchId: dispatch.id,
    recoveryMessageId: recovery.id
  }
}

function commitLegacyCoordinator(db: OrchestrationDb, runId: string): string {
  return db.commitLegacyCompatibilityPrincipal({
    runId,
    role: 'coordinator',
    hostScope: 'local:runtime_1',
    terminalHandle: LEGACY_COORDINATOR_HANDLE,
    paneKey: LEGACY_COORDINATOR_PANE,
    launchTokenHash: 'coord_launch_hash',
    processIncarnation: 'process_coord'
  }).principal.id
}

// Why: --takeover-legacy guards LIVE legacy work only. Settled work has no competing authority to
// seize, and requiring the flag there would strand the recovered graph behind an attestation the
// caller may not hold (runUse rejects the flag unless caller authority matches the binding pane).
describe('adopted Run binding without --takeover-legacy', () => {
  it('fences a bind while legacy work is still live, and names the recovery command', () => {
    const { db, adoptedRunId } = createAdoptedFixture({ settleWork: false })

    expect(() =>
      db.bindRun({
        runId: adoptedRunId,
        coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
        coordinatorPaneKey: CURRENT_COORDINATOR_PANE
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'consumer_fenced',
        data: {
          effectsApplied: false,
          recoveryCommand: `orca orchestration run-use --id ${adoptedRunId} --takeover-legacy`
        }
      })
    )
    expect(db.getRun(adoptedRunId)).toMatchObject({
      coordinator_handle: null,
      coordinator_pane_key: null,
      consumer_generation: 0
    })
  })

  it('claims the settled adopted Run and inherits its recovered task graph', () => {
    const { db, adoptedRunId } = createAdoptedFixture({ settleWork: true })

    const run = db.bindRun({
      runId: adoptedRunId,
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE
    })

    expect(run).toMatchObject({
      coordinator_handle: CURRENT_COORDINATOR_HANDLE,
      coordinator_pane_key: CURRENT_COORDINATOR_PANE,
      consumer_generation: 1
    })
    expect(db.listTasks({ runId: adoptedRunId })).toHaveLength(1)
    expect(db.getCurrentRunForPane(CURRENT_COORDINATOR_PANE)?.id).toBe(adoptedRunId)
  })

  // Why: this is what makes the unflagged claim safe — the recovered coordinator's mail is not orphaned.
  it('promotes the retained coordinator mail onto the claiming Run', () => {
    const { db, adoptedRunId, recoveryMessageId } = createAdoptedFixture({ settleWork: true })
    expect(db.getMessageById(recoveryMessageId)).toMatchObject({
      to_handle: LEGACY_COORDINATOR_HANDLE,
      delivery_contract: 'legacy_direct'
    })

    const run = db.bindRun({
      runId: adoptedRunId,
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE
    })!

    expect(db.getMessageById(recoveryMessageId)).toMatchObject({
      to_handle: `run:${adoptedRunId}`,
      delivery_contract: 'current_delivery',
      read: 0
    })
    expect(
      db
        .getOrCreateRunDelivery({
          runId: adoptedRunId,
          consumerGeneration: run.consumer_generation
        })
        ?.messages.map((message) => message.id)
    ).toContain(recoveryMessageId)
  })

  it('revokes an attested legacy coordinator when it claims the settled Run', () => {
    const { db, adoptedRunId } = createAdoptedFixture({ settleWork: true })
    const principalId = commitLegacyCoordinator(db, adoptedRunId)

    db.bindRun({
      runId: adoptedRunId,
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE
    })

    expect(db.getLegacyCompatibilityPrincipal(principalId)?.status).toBe('revoked')
  })

  // Why: the acknowledgement is per claimant, not one-shot — a prior takeover does not license the next.
  it('keeps fencing new claimants while legacy work stays live', () => {
    const { db, adoptedRunId } = createAdoptedFixture({ settleWork: false })
    db.bindRun({
      runId: adoptedRunId,
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE,
      takeoverLegacy: true
    })

    expect(() =>
      db.bindRun({
        runId: adoptedRunId,
        coordinatorHandle: 'term_second_coord',
        coordinatorPaneKey: 'tab_second:22222222-2222-4222-8222-222222222222'
      })
    ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
  })

  it('lets a later coordinator claim the settled Run once the first one has', () => {
    const { db, adoptedRunId } = createAdoptedFixture({ settleWork: true })
    db.bindRun({
      runId: adoptedRunId,
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE
    })

    expect(
      db.bindRun({
        runId: adoptedRunId,
        coordinatorHandle: 'term_second_coord',
        coordinatorPaneKey: 'tab_second:22222222-2222-4222-8222-222222222222'
      })
    ).toMatchObject({ coordinator_handle: 'term_second_coord', consumer_generation: 2 })
  })
})

// Why: the SQL narrows on the text after the first ':' — a superset of leaf-equivalence — so the
// JS isEquivalentPaneKey filter stays authoritative. These pin both halves of that contract.
describe('pane-bound Run lookup', () => {
  function explain(db: OrchestrationDb, paneKey: string): string {
    const sqlite = (db as unknown as { db: Database.Database }).db
    return (
      sqlite
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT * FROM runs
           WHERE coordinator_pane_key IS NOT NULL AND legacy = 0
             AND substr(coordinator_pane_key, instr(coordinator_pane_key, ':') + 1) = ?
           ORDER BY rowid`
        )
        .all(paneKey) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(' | ')
  }

  it('matches a reminted tab half by leaf UUID', () => {
    const db = track(new OrchestrationDb(':memory:'))
    const run = db.createRun({
      objective: 'work',
      coordinatorHandle: 'term_a',
      coordinatorPaneKey: 'tab_original:77777777-7777-4777-8777-777777777777'
    })

    expect(db.getCurrentRunForPane('tab_broken_out:77777777-7777-4777-8777-777777777777')?.id).toBe(
      run.id
    )
  })

  it('requires an exact match for keys that do not parse', () => {
    const db = track(new OrchestrationDb(':memory:'))
    // Extra ':' makes parsePaneKey return null even though the leaf-looking suffix matches.
    const unparseable = 'tab:extra:88888888-8888-4888-8888-888888888888'
    db.createRun({
      objective: 'unparseable',
      coordinatorHandle: 'term_b',
      coordinatorPaneKey: unparseable
    })

    expect(db.getCurrentRunForPane(unparseable)?.coordinator_pane_key).toBe(unparseable)
    expect(
      db.getCurrentRunForPane('tab_other:88888888-8888-4888-8888-888888888888')
    ).toBeUndefined()
  })

  it('matches colon-free keys only on exact equality', () => {
    const db = track(new OrchestrationDb(':memory:'))
    db.createRun({ objective: 'flat', coordinatorHandle: 'term_c', coordinatorPaneKey: 'flatkey' })

    expect(db.getCurrentRunForPane('flatkey')?.objective).toBe('flat')
    expect(db.getCurrentRunForPane('tab:flatkey')).toBeUndefined()
  })

  it('unbinds only the leaf-equivalent Run when a pane rebinds', () => {
    const db = track(new OrchestrationDb(':memory:'))
    const shared = db.createRun({
      objective: 'first',
      coordinatorHandle: 'term_d',
      coordinatorPaneKey: 'tab_one:99999999-9999-4999-8999-999999999999'
    })
    const untouched = db.createRun({
      objective: 'other pane',
      coordinatorHandle: 'term_e',
      coordinatorPaneKey: 'tab_two:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })

    const rebound = db.createRun({
      objective: 'second',
      coordinatorHandle: 'term_d',
      coordinatorPaneKey: 'tab_reminted:99999999-9999-4999-8999-999999999999'
    })

    // createRun binds at generation 1; the unbind fences it to 2.
    expect(db.getRun(shared.id)).toMatchObject({
      coordinator_pane_key: null,
      consumer_generation: 2
    })
    expect(db.getRun(untouched.id)).toMatchObject({
      coordinator_pane_key: 'tab_two:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    expect(db.getCurrentRunForPane('tab_one:99999999-9999-4999-8999-999999999999')?.id).toBe(
      rebound.id
    )
  })

  it('stays flat as the bound-Run set grows', () => {
    const db = track(new OrchestrationDb(':memory:'))
    const leafOf = (i: number) => `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
    const bind = (from: number, to: number): void => {
      for (let i = from; i < to; i++) {
        db.createRun({
          objective: `run ${i}`,
          coordinatorHandle: `term_${i}`,
          coordinatorPaneKey: `tab_${i}:${leafOf(i)}`
        })
      }
    }
    const probe = `tab_reminted:${leafOf(0)}`
    const measure = (): number => {
      for (let i = 0; i < 200; i++) {
        db.getCurrentRunForPane(probe)
      }
      const start = performance.now()
      for (let i = 0; i < 2000; i++) {
        db.getCurrentRunForPane(probe)
      }
      return (performance.now() - start) / 2000
    }

    bind(0, 61)
    expect(db.getCurrentRunForPane(probe)).toBeDefined()
    const small = measure()
    bind(61, 2001)
    const large = measure()

    // The pre-index scan grew ~28x across this range; the index keeps it flat.
    expect(large).toBeLessThan(small * 6)
    expect(explain(db, 'x')).toContain('USING INDEX idx_runs_coordinator_pane_leaf')
  })

  it('hands the JS filter an O(1) candidate set regardless of bound-Run count', () => {
    const db = track(new OrchestrationDb(':memory:'))
    const sqlite = (db as unknown as { db: Database.Database }).db
    const leaf = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    for (let i = 0; i < 500; i++) {
      db.createRun({
        objective: `run ${i}`,
        coordinatorHandle: `term_${i}`,
        coordinatorPaneKey: `tab_${i}:${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
      })
    }
    db.createRun({
      objective: 'target',
      coordinatorHandle: 'term_target',
      coordinatorPaneKey: `tab_target:${leaf}`
    })

    const candidates = sqlite
      .prepare(
        `SELECT id FROM runs
         WHERE coordinator_pane_key IS NOT NULL AND legacy = 0
           AND substr(coordinator_pane_key, instr(coordinator_pane_key, ':') + 1) = ?`
      )
      .all(leaf) as { id: string }[]

    expect(candidates).toHaveLength(1)
    expect(db.getCurrentRunForPane(`tab_reminted:${leaf}`)?.objective).toBe('target')
  })
})
