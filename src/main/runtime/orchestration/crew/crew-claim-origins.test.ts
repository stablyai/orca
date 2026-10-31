import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { createLegacyStorageCutoverFixture } from '../orchestration-legacy-storage-test-fixture'
import { recordFailedStartDispatchIdentity } from '../db/worker-terminal/failed-start-dispatch-identity'
import { fixture } from './crew-read-model.test-fixture'

// These retained facts are evidence, not an origin certificate for rowid ordering.
describe('retained crew claim provenance', () => {
  it('distinguishes insertion from acquisition and failed-start identity repair', () => {
    const { db, run, assign, handles } = fixture()
    const direct = assign('term_worker')
    db.completeDispatch(direct.id)
    const next = assign('term_worker', 'term_peer')
    expect(next.assignee_pane_key).toBe(direct.assignee_pane_key)
    db.completeDispatch(next.id)
    const start = () =>
      db.createStartingWorkerDispatch({
        taskSpec: 'Delayed claim',
        taskRunId: run.id,
        startOptions: {},
        creator: { kind: 'system' },
        maxDepth: 10
      })
    const older = start()
    const newer = start()
    const attach = (id: string) =>
      db.prepareStartingWorkerAuthority({
        dispatchId: id,
        handle: 'term_worker',
        paneKey: handles.get('term_worker')!,
        processIncarnation: 'process_one',
        worktreeId: 'wt',
        setupState: 'not_applicable',
        effects: []
      })
    attach(newer.dispatch.id)
    db.markWorkerDispatchReady(newer.dispatch.id)
    db.completeDispatch(newer.dispatch.id)
    attach(older.dispatch.id)
    expect(db.getDispatchContextById(older.dispatch.id)?.assignee_handle).toBe('term_worker')
    expect(db.db.prepare('SELECT id FROM dispatch_contexts ORDER BY rowid').all()).toEqual(
      [direct, next, older.dispatch, newer.dispatch].map(({ id }) => ({ id }))
    )
    db.markWorkerDispatchReady(older.dispatch.id)
    db.completeDispatch(older.dispatch.id)
    const failed = start()
    db.recordCreatedWorkerTerminalCustody({
      dispatchId: failed.dispatch.id,
      handle: 'term_worker',
      paneKey: handles.get('term_worker')!,
      processIncarnation: 'process_one',
      worktreeId: 'wt'
    })
    db.recordWorkerStage({
      dispatchId: failed.dispatch.id,
      stage: 'agent_readiness',
      terminalHandle: 'term_worker'
    })
    expect(db.getDispatchContextById(failed.dispatch.id)?.assignee_handle).toBeNull()
    db.failWorkerStart(failed.dispatch.id, 'agent_readiness', 'Agent did not start')
    expect(db.getDispatchContextById(failed.dispatch.id)?.assignee_handle).toBe('term_worker')
    // The production repair can be repeated after settlement without changing row birth.
    recordFailedStartDispatchIdentity(db, db.getWorkerDispatch(failed.dispatch.id)!)
    expect(db.getDispatchContextById(failed.dispatch.id)?.assignee_handle).toBe('term_worker')
    const oldPane = handles.get('term_worker')!
    const movedPane = oldPane.replace('tab_worker:', 'tab_moved:')
    db.rekeyWorkerTerminalResourcePaneKey({ fromPaneKey: oldPane, toPaneKey: movedPane })
    expect(db.getWorkerTerminalResourceByOwner(failed.dispatch.id)?.pane_key).toBe(movedPane)
    expect(db.getDispatchContextById(failed.dispatch.id)?.assignee_pane_key).toBe(oldPane)
    console.log(
      'claim origin trace',
      JSON.stringify({
        direct: direct.id,
        sequential: next.id,
        delayedBirth: [older.dispatch.id, newer.dispatch.id],
        acquisition: [newer.dispatch.id, older.dispatch.id],
        failedIdentity: failed.dispatch.id
      })
    )
  })

  it('reopens supported legacy storage without inventing an atomic origin certificate', () => {
    const legacy = createLegacyStorageCutoverFixture()
    // Kept as private fixture evidence; no user profile or login storage is read.
    const db = new OrchestrationDb(legacy.fixture.dbPath)
    try {
      const retained = db.getDispatchContextById(legacy.fixture.legacyDispatchId)!
      expect(retained.run_id).toBe(db.getLegacyAdoption()?.adopted_run_id)
      expect(db.getWorkerDispatch(retained.id)).toBeUndefined()
      expect(retained.assignee_handle).toBe('term_legacy_worker')
      console.log(
        'legacy claim origin trace',
        JSON.stringify({
          path: legacy.fixture.dbPath,
          run: retained.run_id,
          contract: retained.contract_version,
          companion: false
        })
      )
    } finally {
      db.close()
    }
  })
})
