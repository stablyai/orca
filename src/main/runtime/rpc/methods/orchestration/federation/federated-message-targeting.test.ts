import '../../../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { RpcRequest } from '../../../core'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../../orchestration'

describe('orchestration federated message targeting', () => {
  let db: OrchestrationDb | undefined
  let runtime: OrcaRuntimeService | undefined

  afterEach(() => {
    runtime?.stopOrchestrationFederationRelay()
    db?.close()
  })

  it('rejects explicit send and ask targets without enqueueing a relay', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    const dispatchId = 'ctx_remote_targeting'
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const requests: RpcRequest[] = [
      request('send_to', 'orchestration.send', {
        from: 'term_remote_worker',
        to: 'run:explicit',
        subject: 'Wrong explicit target'
      }),
      request('send_run', 'orchestration.send', {
        from: 'term_remote_worker',
        run: 'run_explicit',
        subject: 'Wrong explicit Run'
      }),
      request('ask_to', 'orchestration.ask', {
        from: 'term_remote_worker',
        to: 'run:explicit',
        question: 'Wrong explicit target?'
      }),
      request('ask_run', 'orchestration.ask', {
        from: 'term_remote_worker',
        run: 'run_explicit',
        question: 'Wrong explicit Run?'
      })
    ]

    for (const item of requests) {
      await expect(dispatcher.dispatch(item)).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'invalid_argument',
          message: 'Federated Dispatch messages route to their Run home; omit --to and --run.'
        }
      })
    }
    expect(
      db.listFederationRelay({ dispatchId, direction: 'to_home', afterSequence: 0 })
    ).toHaveLength(0)
  })

  it('delivers a send that names its own Run home to that home', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    for (const [id, target] of [
      ['home_to', { to: 'run:run-home' }],
      ['home_run', { run: 'run-home' }]
    ] as const) {
      await expect(
        dispatcher.dispatch(
          request(id, 'orchestration.send', {
            from: 'term_remote_worker',
            ...target,
            subject: 'Progress'
          })
        )
      ).resolves.toMatchObject({ ok: true })
    }
    await expect(
      dispatcher.dispatch(
        request('home_ask', 'orchestration.ask', {
          from: 'term_remote_worker',
          to: 'run:run-home',
          question: 'Which branch?',
          timeoutMs: 0
        })
      )
    ).resolves.toMatchObject({ ok: true, result: { timedOut: true } })
    expect(
      db
        .listFederationRelay({
          dispatchId: 'ctx_remote_targeting',
          direction: 'to_home',
          afterSequence: 0
        })
        .map((item) => item.kind)
    ).toEqual(['status', 'status', 'question'])
    expect(db.getInbox()).toHaveLength(0)
  })

  it('refuses a Run a remote Dispatch here reports to once the link to it is lost', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    // The agent now runs in a pane its remote Dispatch was never attached to.
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_other:leaf_other')
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    for (const [id, target] of [
      ['lost_to', { to: 'run:run-home' }],
      ['lost_run', { run: 'run-home' }]
    ] as const) {
      await expect(
        dispatcher.dispatch(
          request(id, 'orchestration.send', {
            from: 'term_remote_worker',
            ...target,
            type: 'worker_done',
            subject: 'Done',
            payload: JSON.stringify({ outcome: 'succeeded' })
          })
        )
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'run_home_unreachable',
          message:
            "Run run-home lives on the computer that coordinates it, which isn't reachable from here: this terminal is no longer attached to its Dispatch ctx_remote_targeting. Nothing was sent."
        }
      })
    }
    expect(db.getInbox()).toHaveLength(0)
    expect(
      db.listFederationRelay({
        dispatchId: 'ctx_remote_targeting',
        direction: 'to_home',
        afterSequence: 0
      })
    ).toHaveLength(0)
  })

  it('still delivers to a local Run no remote Dispatch reports to', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_other:leaf_other')
    const local = db.createRun({
      objective: 'local run',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:leaf_coordinator'
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    await expect(
      dispatcher.dispatch(
        request('local_to', 'orchestration.send', {
          from: 'term_local_sender',
          to: `run:${local.id}`,
          subject: 'Hello'
        })
      )
    ).resolves.toMatchObject({ ok: true })
    expect(db.getInbox().map((message) => message.to_handle)).toEqual([`run:${local.id}`])
  })

  it('delivers to a local Run a loopback remote Dispatch also reports to', async () => {
    const loopbackDb = new OrchestrationDb(':memory:')
    db = loopbackDb
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(loopbackDb)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_coordinator:leaf_coordinator')
    const local = loopbackDb.createRun({
      objective: 'loopback run',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:leaf_coordinator'
    })
    attachRemoteDispatch(loopbackDb, runtime, local.id)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    await expect(
      dispatcher.dispatch(
        request('loopback_run', 'orchestration.send', {
          from: 'term_coordinator',
          run: local.id,
          subject: 'Hello'
        })
      )
    ).resolves.toMatchObject({ ok: true })
    expect(loopbackDb.getInbox().map((message) => message.run_id)).toEqual([local.id])
  })

  it('answers coordinator mail at the Run home, or refuses once the link is lost', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    const mirrorDb = db
    const coordinatorMail = mirrorDb.insertMessage({
      id: 'msg_home_control',
      runId: 'run-home',
      from: 'term_coordinator',
      to: 'dispatch:ctx_remote_targeting',
      subject: 'Status?',
      body: 'How far along?'
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    await expect(
      dispatcher.dispatch(
        request('reply_linked', 'orchestration.reply', {
          from: 'term_remote_worker',
          id: coordinatorMail.id,
          body: 'Halfway.'
        })
      )
    ).resolves.toMatchObject({ ok: true, result: { message: { subject: 'Re: Status?' } } })
    const relayed = mirrorDb.listFederationRelay({
      dispatchId: 'ctx_remote_targeting',
      direction: 'to_home',
      afterSequence: 0
    })
    expect(relayed.map((item) => JSON.parse(item.payload).threadId)).toEqual([coordinatorMail.id])

    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_other:leaf_other')
    await expect(
      dispatcher.dispatch(
        request('reply_lost', 'orchestration.reply', {
          from: 'term_remote_worker',
          id: coordinatorMail.id,
          body: 'Done.'
        })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'run_home_unreachable' } })
    expect(mirrorDb.getInbox().map((message) => message.id)).toEqual([coordinatorMail.id])
  })

  it("refuses a reply to mail sent to another worker's Dispatch of the same Run", async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    const mirrorDb = db
    const otherWorkerMail = mirrorDb.insertMessage({
      id: 'msg_home_other_worker',
      runId: 'run-home',
      from: 'term_coordinator',
      to: 'dispatch:ctx_other_worker',
      subject: 'Status?',
      body: 'How far along?'
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    await expect(
      dispatcher.dispatch(
        request('reply_other', 'orchestration.reply', {
          from: 'term_remote_worker',
          id: otherWorkerMail.id,
          body: 'Not mine.'
        })
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'run_home_unreachable' } })
    expect(
      mirrorDb.listFederationRelay({
        dispatchId: 'ctx_remote_targeting',
        direction: 'to_home',
        afterSequence: 0
      })
    ).toHaveLength(0)
  })
})

/** A worker pane bound to remote Dispatch ctx_remote_targeting, whose Run home is `run-home`. */
function attachedRemoteWorker(): { db: OrchestrationDb; runtime: OrcaRuntimeService } {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
  attachRemoteDispatch(db, runtime, 'run-home')
  return { db, runtime }
}

function attachRemoteDispatch(db: OrchestrationDb, runtime: OrcaRuntimeService, runId: string) {
  const processIncarnation = 'worker_epoch:pty:1'
  const dispatchId = 'ctx_remote_targeting'
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(processIncarnation)
  db.createRemoteDispatchAttachment({
    runId,
    dispatchId,
    taskId: 'task_remote_targeting',
    homePeerFingerprint: 'home_peer',
    protocolVersion: 1,
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: {
      callerFingerprint: 'home_peer',
      requestId: 'attach_request',
      method: 'orchestration.federationAttachStart',
      payloadHash: 'attach_payload'
    }
  })
  db.prepareRemoteAttachmentAuthority({
    dispatchId,
    paneKey: 'tab_worker:leaf_worker',
    processIncarnation,
    worktreeId: 'repo::remote-worktree',
    terminalHandle: 'term_remote_worker',
    setupState: 'not_applicable',
    effects: []
  })
  db.markRemoteAttachmentReady(dispatchId)
}

function request(
  id: string,
  method: 'orchestration.send' | 'orchestration.ask' | 'orchestration.reply',
  params: Record<string, unknown>
): RpcRequest {
  return {
    id: `rpc_${id}`,
    authToken: 'worker-token',
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: `request_${id}`,
    method,
    params
  }
}
