import '../../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { CrewReadModel } from './crew-read-model'
import { fixture } from './crew-read-model.test-fixture'

it('reuses indexed attachment facts for reminted panes without per-peer queries or viewer mutation', () => {
  const { db, deps, handles } = fixture()
  handles.set('term_worker', 'tab_worker:77777777-7777-4777-8777-777777777777')
  deps.processForHandle = () => 'worker_process'
  db.createRemoteDispatchAttachment({
    dispatchId: 'ctx_moved',
    runId: 'run_moved',
    taskId: 'task_moved',
    homePeerFingerprint: 'home_peer',
    protocolVersion: 1,
    runtimeEpoch: 'epoch',
    mutationReceipt: {
      callerFingerprint: 'home_peer',
      requestId: 'attach_moved',
      method: 'orchestration.federationAttachStart',
      payloadHash: 'moved'
    }
  })
  db.prepareRemoteAttachmentAuthority({
    dispatchId: 'ctx_moved',
    terminalHandle: 'term_worker',
    paneKey: handles.get('term_worker')!,
    processIncarnation: 'worker_process',
    worktreeId: 'folder-worker',
    setupState: 'not_applicable',
    effects: []
  })
  db.markRemoteAttachmentReady('ctx_moved')
  const leaf = handles.get('term_worker')!.split(':')[1]
  handles.set('term_worker', `moved_tab:${leaf}`)
  expect(db.findActiveRemoteAttachmentForPane(handles.get('term_worker')!)?.dispatch_id).toBe(
    'ctx_moved'
  )
  for (const population of [10, 100]) {
    for (let i = population === 10 ? 0 : 10; i < population; i++) {
      const handle = `term_population_${i}`
      handles.set(handle, `pane_${i}`)
      db.insertMessage({ from: handle, to: 'term_worker', subject: 'Peer', body: `peer ${i}` })
    }
    const model = new CrewReadModel(() => deps, db.crewChanges.subscribe)
    const stop = model.subscribe(() => {})
    try {
      const lookup = vi.spyOn(db, 'findActiveRemoteAttachmentForPane')
      const prepare = vi.spyOn(db.db, 'prepare')
      const snapshot = model.read('term_worker')
      expect(snapshot.sections.talkingWith).toHaveLength(population)
      expect(
        snapshot.sections.talkingWith.every(
          (row) =>
            row.sendAddress === undefined && row.openTarget?.kind === 'terminal' && row.latest
        )
      ).toBe(true)
      expect(lookup).not.toHaveBeenCalled()
      const cold = prepare.mock.calls.length
      prepare.mockClear()
      expect(model.read('term_worker')).toEqual(snapshot)
      expect(prepare.mock.calls.length).toBeLessThan(cold)
      expect(prepare.mock.calls.length).toBe(4)
      lookup.mockRestore()
      prepare.mockRestore()
    } finally {
      stop()
    }
  }
})
