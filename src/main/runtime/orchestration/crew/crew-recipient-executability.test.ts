import '../../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { ORCHESTRATION_SEND_METHODS } from '../../rpc/methods/orchestration/messaging/send-methods'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { importFederatedControlMessage } from '../federation-control-message'
import { CrewReadModel } from './crew-read-model'
import { fixture } from './crew-read-model.test-fixture'

it('projects only executable peer addresses per viewer while retaining home routing and imported peer content', async () => {
  const { db, deps, handles } = fixture()
  handles.set('term_worker', 'tab_worker:77777777-7777-4777-8777-777777777777')
  deps.processForHandle = () => 'worker_process'
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation(
    (handle) => handles.get(handle) ?? null
  )
  vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation(
    (handle) => handles.get(handle) ?? null
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('worker_process')
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  vi.spyOn(runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
  const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_SEND_METHODS })
  let requestId = 0
  const send = (from: string, to: string) => {
    const id = `recipient_${requestId++}`
    return dispatcher.dispatch({
      id,
      authToken: 'fixture-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: id,
      method: 'orchestration.send',
      params: { from, to, subject: 'Ordinary individual message', body: 'hello' }
    })
  }
  db.insertMessage({ from: 'term_worker', to: 'term_peer', subject: 'Local', body: 'latest local' })
  db.insertMessage({ from: 'term_outbound', to: 'term_peer', subject: 'Local', body: 'ordinary' })
  const model = new CrewReadModel(() => deps, db.crewChanges.subscribe)
  const stop = model.subscribe(() => {})
  try {
    const original = model.read('term_worker').sections.talkingWith[0]
    expect(original.sendAddress).toBe('term_peer')
    await expect(send('term_worker', original.sendAddress!)).resolves.toMatchObject({ ok: true })
    const before = model.read('term_worker').sections.talkingWith[0]
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_recipient',
      runId: 'run_home',
      taskId: 'task_recipient',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 1,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: 'attach_recipient',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach_recipient'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: 'ctx_recipient',
      terminalHandle: 'term_worker',
      paneKey: handles.get('term_worker')!,
      processIncarnation: 'worker_process',
      worktreeId: 'folder-worker',
      setupState: 'not_applicable',
      effects: []
    })
    db.markRemoteAttachmentReady('ctx_recipient')
    const attached = model.read('term_worker')
    const { sendAddress, ...retained } = before
    expect(sendAddress).toBe('term_peer')
    expect(attached.sections.talkingWith).toEqual([retained])
    expect(retained.openTarget).toEqual({ kind: 'terminal', handle: 'term_peer' })
    expect(attached.sections.managedBy[0].sendAddress).toBe('run:run_home')
    await expect(
      send('term_worker', attached.sections.managedBy[0].sendAddress!)
    ).resolves.toMatchObject({ ok: true })
    expect(
      db.listFederationRelay({
        dispatchId: 'ctx_recipient',
        direction: 'to_home',
        afterSequence: 0
      })
    ).toHaveLength(1)

    const homeSession = 'orca_session_id:4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
    expect(
      importFederatedControlMessage(db, {
        dispatchId: 'ctx_recipient',
        messageId: 'imported_home_peer',
        payload: JSON.stringify({
          from: homeSession,
          subject: 'Home peer',
          body: 'latest imported',
          type: 'status',
          priority: 'normal',
          threadId: null,
          payload: null
        })
      }).imported
    ).toBe(true)
    const peers = model.read('term_worker').sections.talkingWith
    expect(peers).toHaveLength(2)
    expect(peers[0]).toMatchObject({
      partyKey: JSON.stringify(['test-host', homeSession]),
      role: 'peer',
      label: 'Duplicate name',
      latest: { direction: 'from', preview: 'latest imported' }
    })
    expect(peers.every((row) => !Object.hasOwn(row, 'sendAddress'))).toBe(true)
    const messages = db.getInbox()
    for (const to of ['term_peer', homeSession]) {
      await expect(send('term_worker', to)).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'invalid_argument',
          message: 'Federated Dispatch messages route to their Run home; omit --to and --run.'
        }
      })
    }
    expect(db.getInbox()).toEqual(messages)
    expect(
      db.listFederationRelay({
        dispatchId: 'ctx_recipient',
        direction: 'to_home',
        afterSequence: 0
      })
    ).toHaveLength(1)

    const ordinary = model.read('term_outbound')
    expect(ordinary.sections.talkingWith[0].sendAddress).toBe('term_peer')
    expect(model.read('dispatch:ctx_recipient').sections.talkingWith).toEqual(peers)
    expect(model.read('term_outbound')).toEqual(ordinary)
    expect(model.read('term_worker').sections.talkingWith).toEqual(peers)
    await expect(send('term_outbound', 'term_peer')).resolves.toMatchObject({ ok: true })

    // Historical provenance still admits the relation, but only the active route constrains sends.
    db.beginRemoteAttachmentStop('ctx_recipient')
    db.settleRemoteAttachmentStop('ctx_recipient')
    expect(db.findActiveRemoteAttachmentForPane(handles.get('term_worker')!)).toBeUndefined()
    const ended = model.read('term_worker')
    expect(ended.sections.managedBy).toEqual(attached.sections.managedBy)
    expect(ended.sections.talkingWith.find((row) => row.partyKey === retained.partyKey)).toEqual(
      before
    )
    await expect(send('term_worker', 'term_peer')).resolves.toMatchObject({ ok: true })
  } finally {
    stop()
    runtime.stopOrchestrationFederationRelay()
  }
})

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
      console.info('recipient route work', { population, cold, warm: prepare.mock.calls.length })
      lookup.mockRestore()
      prepare.mockRestore()
    } finally {
      stop()
    }
  }
})
