import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import { createRootDispatch } from '../root-dispatch-test-fixture'

const LEGACY_COORDINATOR_HANDLE = 'term_legacy_coord'
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
    runId: 'run_legacy_local',
    spec: 'legacy assignment',
    createdByTerminalHandle: LEGACY_COORDINATOR_HANDLE
  })
  const dispatch = createRootDispatch(before, task.id, LEGACY_WORKER_HANDLE, LEGACY_WORKER_PANE)
  const recovery = before.insertMessage({
    runId: 'run_legacy_local',
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

// Only live legacy work needs takeover attestation; settled work has no authority left to seize.
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

  it('withholds legacy takeover advice and refuses explicit worker takeovers without effects', () => {
    const { db, adoptedRunId, recoveryMessageId } = createAdoptedFixture({ settleWork: false })
    const home = db.createRun({
      objective: 'worker home',
      coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
      coordinatorPaneKey: CURRENT_COORDINATOR_PANE
    })
    const worker = createRootDispatch(
      db,
      db.createTask({ runId: home.id, spec: 'worker' }).id,
      'term_foreign_worker',
      'tab_foreign:22222222-2222-4222-8222-222222222222'
    )
    const before = {
      adoptedRun: db.getRun(adoptedRunId),
      homeRun: db.getRun(home.id),
      dispatch: db.getDispatchContextById(worker.id),
      mail: db.getMessageById(recoveryMessageId)
    }
    try {
      db.bindRun({
        runId: adoptedRunId,
        coordinatorHandle: 'term_foreign_worker',
        coordinatorPaneKey: 'tab_foreign:22222222-2222-4222-8222-222222222222'
      })
      throw new Error('Expected the legacy bind to be fenced')
    } catch (error) {
      expect(error).toMatchObject({ code: 'consumer_fenced', data: { effectsApplied: false } })
      expect(JSON.stringify(error)).not.toContain('run-use')
    }
    for (const [runId, code] of [
      [adoptedRunId, 'worker_cannot_take_over_run'],
      [home.id, 'worker_cannot_coordinate_own_run']
    ] as const) {
      expect(() =>
        db.bindRun({
          runId,
          coordinatorHandle: 'term_foreign_worker',
          coordinatorPaneKey: 'tab_foreign:22222222-2222-4222-8222-222222222222',
          takeoverLegacy: true
        })
      ).toThrowError(
        expect.objectContaining({
          code,
          data: { effectsApplied: false, dispatchId: worker.id }
        })
      )
      expect({
        adoptedRun: db.getRun(adoptedRunId),
        homeRun: db.getRun(home.id),
        dispatch: db.getDispatchContextById(worker.id),
        mail: db.getMessageById(recoveryMessageId)
      }).toEqual(before)
    }
  })

  // An unflagged claim must preserve the recovered coordinator's mail.
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

  // Each new claimant needs its own takeover acknowledgment.
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
})

// SQL suffix matches are candidates; isEquivalentPaneKey remains authoritative.
describe('pane-bound Run lookup', () => {
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
    db.bindRun({
      runId: rebound.id,
      coordinatorHandle: 'term_d',
      coordinatorPaneKey: 'tab_reminted:99999999-9999-4999-8999-999999999999'
    })

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
})
