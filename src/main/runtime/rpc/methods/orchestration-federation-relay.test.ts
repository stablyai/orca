import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { createFederationWorkerStartRequest as startRequest } from './orchestration/federation/federation-request.test-support'
import { createFederationPeers, type FederationPeers } from './orchestration-federation-peers'

describe('orchestration federation relay', () => {
  let peers: FederationPeers

  beforeEach(() => {
    peers = createFederationPeers()
  })

  afterEach(() => {
    peers.close()
  })

  it('durably relays remote completion into the home Run and acknowledges it', async () => {
    const task = peers.createHomeTask()
    const started = await peers.homeDispatcher.dispatch(startRequest(task.id))
    expect(started.ok).toBe(true)
    const dispatch = peers.homeDb.getDispatchContext(task.id)!
    const prompt = vi.mocked(peers.workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    expect(capability).toBeTruthy()

    const sent = await peers.workerDispatcher.dispatch({
      id: 'rpc_worker_done',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'worker_done_request',
      orchestrationCapability: capability,
      method: 'orchestration.send',
      params: {
        from: 'term_windows_worker',
        subject: 'Windows audit complete',
        body: 'Audited Windows behavior. Found no blocker. Nothing remains.',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          attemptId: 'attempt_windows_worker',
          outcome: 'succeeded',
          filesModified: []
        })
      }
    })
    expect(sent).toMatchObject({
      ok: true,
      result: { lifecycle: { action: 'completed' } }
    })
    expect(peers.homeDb.getTask(task.id)?.status).toBe('completed')

    await peers.homeRuntime.syncOrchestrationFederation()

    expect(peers.homeDb.getTask(task.id)?.status).toBe('completed')
    expect(peers.homeDb.getWorkerDispatch(dispatch.id)?.state).toBe('succeeded')
    expect(peers.homeDb.getRunMailboxHistory(task.run_id, 10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^relay_/),
          type: 'worker_done',
          subject: 'Windows audit complete'
        })
      ])
    )
    expect(
      peers.workerDb.listFederationRelay({
        dispatchId: dispatch.id,
        direction: 'to_home',
        afterSequence: 0
      })[0]
    ).toMatchObject({ acked_at: expect.any(String) })
  })

  it('relays a worker question home and the coordinator answer back', async () => {
    const task = peers.createHomeTask()
    await peers.homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = peers.homeDb.getDispatchContext(task.id)!
    const prompt = vi.mocked(peers.workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    const ask = peers.workerDispatcher.dispatch({
      id: 'rpc_remote_ask',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_question_request',
      orchestrationCapability: capability,
      method: 'orchestration.ask',
      params: {
        from: 'term_windows_worker',
        question: 'Should I include slow integration tests?',
        options: 'yes,no',
        timeoutMs: 60_000
      }
    })
    await vi.waitFor(() =>
      expect(
        peers.workerDb.listFederationRelay({
          dispatchId: dispatch.id,
          direction: 'to_home',
          afterSequence: 0
        })
      ).toHaveLength(1)
    )

    await peers.homeRuntime.syncOrchestrationFederation()
    const question = peers.homeDb
      .getRunMailboxHistory(task.run_id, 10)
      .find((message) => message.type === 'question')
    expect(question).toMatchObject({
      body: 'Should I include slow integration tests?'
    })

    const reply = await peers.homeDispatcher.dispatch({
      id: 'rpc_home_reply',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'home_reply_request',
      method: 'orchestration.reply',
      params: {
        id: question!.id,
        body: 'yes',
        from: 'term_coord'
      }
    })
    expect(reply).toMatchObject({ ok: true, result: { question: { status: 'answered' } } })
    await peers.homeRuntime.syncOrchestrationFederation()

    await expect(ask).resolves.toMatchObject({
      ok: true,
      result: {
        answer: 'yes',
        messageId: question!.id,
        timedOut: false
      }
    })
    expect(
      peers.homeDb.listFederationRelay({
        dispatchId: dispatch.id,
        direction: 'to_worker',
        afterSequence: 0
      })[0]
    ).toMatchObject({ acked_at: expect.any(String) })
  })

  it('keeps a timed-out remote question resumable', async () => {
    const task = peers.createHomeTask()
    await peers.homeDispatcher.dispatch(startRequest(task.id))
    const prompt = vi.mocked(peers.workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    const timedOut = await peers.workerDispatcher.dispatch({
      id: 'rpc_remote_ask_timeout',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_question_timeout_request',
      orchestrationCapability: capability,
      method: 'orchestration.ask',
      params: {
        from: 'term_windows_worker',
        question: 'Resume this later?',
        timeoutMs: 1
      }
    })
    expect(timedOut).toMatchObject({
      ok: true,
      result: { timedOut: true, messageId: expect.stringMatching(/^relay_/) }
    })
    const questionId = (timedOut as { result: { messageId: string } }).result.messageId

    await peers.homeRuntime.syncOrchestrationFederation()
    await peers.homeDispatcher.dispatch({
      id: 'rpc_home_late_reply',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'home_late_reply_request',
      method: 'orchestration.reply',
      params: { id: questionId, body: 'yes', from: 'term_coord' }
    })
    peers.restartWorkerRuntime()
    const resumed = peers.workerDispatcher.dispatch({
      id: 'rpc_remote_ask_resume',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_question_resume_request',
      orchestrationCapability: capability,
      method: 'orchestration.ask',
      params: { from: 'term_windows_worker', resume: questionId, timeoutMs: 5_000 }
    })
    await peers.homeRuntime.syncOrchestrationFederation()

    await expect(resumed).resolves.toMatchObject({
      ok: true,
      result: { answer: 'yes', messageId: questionId, timedOut: false }
    })
  })

  it('retries a lost relay acknowledgment without duplicating the home message', async () => {
    const task = peers.createHomeTask()
    await peers.homeDispatcher.dispatch(startRequest(task.id))
    peers.homeRuntime.stopOrchestrationFederationRelay()
    const prompt = vi.mocked(peers.workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    await peers.workerDispatcher.dispatch({
      id: 'rpc_remote_status',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_status_request',
      orchestrationCapability: capability,
      method: 'orchestration.send',
      params: {
        from: 'term_windows_worker',
        subject: 'Checkpoint',
        body: 'One durable update',
        type: 'status'
      }
    })
    peers.loseNextAckResponse = true
    const remoteCall = vi.spyOn(peers.homeRuntime, 'callOrchestrationWorkerServer')

    await expect(peers.homeRuntime.syncOrchestrationFederation()).resolves.toBeUndefined()
    await peers.homeRuntime.syncOrchestrationFederation()

    expect(
      peers.homeDb
        .getRunMailboxHistory(task.run_id, 10)
        .filter((message) => message.subject === 'Checkpoint')
    ).toHaveLength(1)
    const acknowledgments = remoteCall.mock.calls.filter(
      ([, method]) => method === 'orchestration.federationAck'
    )
    expect(acknowledgments).toHaveLength(2)
  })

  it('rejects a reordered relay gap, then converges without loss or duplication', async () => {
    const task = peers.createHomeTask()
    await peers.homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = peers.homeDb.getDispatchContext(task.id)!

    expect(() =>
      peers.homeDb.importFederatedRelayItem({
        dispatchId: dispatch.id,
        sequence: 2,
        message: {
          id: 'relay_gap',
          runId: task.run_id,
          from: `dispatch:${dispatch.id}`,
          to: `run:${task.run_id}`,
          subject: 'Gap',
          body: 'Out of order',
          type: 'status',
          priority: 'normal'
        },
        lifecycle: { kind: 'none' }
      })
    ).toThrow(/not contiguous/)
    expect(peers.homeDb.getMessageById('relay_gap')).toBeUndefined()
    expect(peers.homeDb.getFederatedDispatch(dispatch.id)?.to_home_imported_sequence).toBe(0)

    peers.homeDb.importFederatedRelayItem({
      dispatchId: dispatch.id,
      sequence: 1,
      message: {
        id: 'relay_first',
        runId: task.run_id,
        from: `dispatch:${dispatch.id}`,
        to: `run:${task.run_id}`,
        subject: 'First',
        body: 'Arrived after the gap was rejected',
        type: 'status',
        priority: 'normal'
      },
      lifecycle: { kind: 'none' }
    })
    const recovered = peers.homeDb.importFederatedRelayItem({
      dispatchId: dispatch.id,
      sequence: 2,
      message: {
        id: 'relay_gap',
        runId: task.run_id,
        from: `dispatch:${dispatch.id}`,
        to: `run:${task.run_id}`,
        subject: 'Gap',
        body: 'Out of order',
        type: 'status',
        priority: 'normal'
      },
      lifecycle: { kind: 'none' }
    })
    const duplicate = peers.homeDb.importFederatedRelayItem({
      dispatchId: dispatch.id,
      sequence: 2,
      message: {
        id: 'relay_gap',
        runId: task.run_id,
        from: `dispatch:${dispatch.id}`,
        to: `run:${task.run_id}`,
        subject: 'Gap',
        body: 'Out of order',
        type: 'status',
        priority: 'normal'
      },
      lifecycle: { kind: 'none' }
    })

    expect(recovered.duplicate).toBe(false)
    expect(duplicate.duplicate).toBe(true)
    expect(peers.homeDb.getFederatedDispatch(dispatch.id)?.to_home_imported_sequence).toBe(2)
    expect(
      peers.homeDb
        .getRunMailboxHistory(task.run_id, 10)
        .filter((message) => ['relay_first', 'relay_gap'].includes(message.id))
    ).toHaveLength(2)
  })

  it('restarts relay polling when a federated worker is shown', async () => {
    const task = peers.createHomeTask()
    await peers.homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = peers.homeDb.getDispatchContext(task.id)!
    const prompt = vi.mocked(peers.workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    peers.homeRuntime.stopOrchestrationFederationRelay()
    await peers.workerDispatcher.dispatch({
      id: 'rpc_restart_status',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'restart_status_request',
      orchestrationCapability: capability,
      method: 'orchestration.send',
      params: {
        from: 'term_windows_worker',
        subject: 'After home restart',
        body: 'Relay me after worker-show',
        type: 'status'
      }
    })

    await peers.homeDispatcher.dispatch({
      id: 'rpc_restart_show',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatch.id }
    })

    await vi.waitFor(() =>
      expect(
        peers.homeDb
          .getRunMailboxHistory(task.run_id, 10)
          .some((message) => message.subject === 'After home restart')
      ).toBe(true)
    )
  })

  it('treats a worker runtime ID change as an epoch, not a new server', async () => {
    const task = peers.createHomeTask()
    await peers.homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = peers.homeDb.getDispatchContext(task.id)!
    const oldEpoch = peers.homeDb.getFederatedDispatch(dispatch.id)?.remote_runtime_epoch
    peers.restartWorkerRuntime()

    const changedEpoch = await peers.homeDispatcher.dispatch({
      id: 'rpc_worker_restart_show',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatch.id }
    })
    const shown = await peers.homeDispatcher.dispatch({
      id: 'rpc_worker_restart_show_current',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatch.id }
    })

    expect(changedEpoch).toMatchObject({
      ok: true,
      result: { observation: { status: 'unverifiable', exactWorker: false } }
    })
    expect(shown).toMatchObject({
      ok: true,
      result: { observation: { status: 'live', exactWorker: true } }
    })
    expect(peers.homeDb.getFederatedDispatch(dispatch.id)?.remote_runtime_epoch).not.toBe(oldEpoch)
    expect(peers.homeDb.getFederatedDispatch(dispatch.id)?.peer_fingerprint).toBe(
      'windows_peer_fingerprint'
    )
  })

  it('stops only the exact remote agent terminal', async () => {
    const task = peers.createHomeTask()
    await peers.homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = peers.homeDb.getDispatchContext(task.id)!

    const stopped = await peers.homeDispatcher.dispatch({
      id: 'rpc_remote_stop',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'request_remote_stop',
      method: 'orchestration.workerStop',
      params: { dispatch: dispatch.id }
    })

    expect(stopped).toMatchObject({
      ok: true,
      result: { state: 'stopped', processAction: 'closed_agent_terminal' }
    })
    expect(peers.workerRuntime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(peers.workerRuntime.closeTerminal).toHaveBeenCalledWith('term_windows_worker')
    expect(peers.homeDb.getTask(task.id)?.status).toBe('blocked')

    vi.mocked(peers.workerRuntime.showTerminal).mockResolvedValue({
      handle: 'term_windows_worker',
      worktreeId: 'repo::windows-worktree',
      connected: false,
      writable: false
    } as never)
    vi.mocked(peers.workerRuntime.getTerminalLivenessVerdict).mockReturnValue({ status: 'exited' })
    await peers.homeDispatcher.dispatch({
      id: 'rpc_remote_show_after_stop',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatch.id }
    })
    const shown = await peers.homeDispatcher.dispatch({
      id: 'rpc_remote_show_after_stop_current',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatch.id }
    })
    expect(shown).toMatchObject({
      ok: true,
      result: { observation: { status: 'exited', exactWorker: true } }
    })
  })

  it('rejects a re-paired server before show or stop effects', async () => {
    const task = peers.createHomeTask()
    await peers.homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = peers.homeDb.getDispatchContext(task.id)!
    peers.workerPeerFingerprint = 'replacement_windows_peer'

    const shown = await peers.homeDispatcher.dispatch({
      id: 'rpc_changed_peer_show',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatch.id }
    })
    const stopped = await peers.homeDispatcher.dispatch({
      id: 'rpc_changed_peer_stop',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'request_changed_peer_stop',
      method: 'orchestration.workerStop',
      params: { dispatch: dispatch.id }
    })

    expect(shown).toMatchObject({ ok: false, error: { code: 'peer_changed' } })
    expect(stopped).toMatchObject({ ok: false, error: { code: 'peer_changed' } })
    expect(peers.homeDb.getWorkerDispatch(dispatch.id)?.state).toBe('ready')
    expect(peers.workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('coalesces overlapping relay polls for the same Dispatch', async () => {
    const task = peers.createHomeTask()
    await peers.homeDispatcher.dispatch(startRequest(task.id))
    await peers.homeRuntime.syncOrchestrationFederation()
    peers.homeRuntime.stopOrchestrationFederationRelay()

    let releasePull!: () => void
    const blockedPull = new Promise<void>((resolve) => {
      releasePull = resolve
    })
    let pullCount = 0
    vi.spyOn(peers.homeRuntime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_selector, method) => {
        if (method !== 'orchestration.federationPull') {
          throw new Error(`Unexpected relay method ${method}`)
        }
        pullCount += 1
        await blockedPull
        return { runtimeEpoch: peers.workerRuntime.getRuntimeId(), items: [] }
      }
    )

    const first = peers.homeRuntime.syncOrchestrationFederation()
    const second = peers.homeRuntime.syncOrchestrationFederation()
    await vi.waitFor(() => expect(pullCount).toBe(1))
    releasePull()
    await Promise.all([first, second])

    expect(pullCount).toBe(1)
  })

  it('warns once while a federated Dispatch remains unreachable', async () => {
    const task = peers.createHomeTask()
    await peers.homeDispatcher.dispatch(startRequest(task.id))
    await peers.homeRuntime.syncOrchestrationFederation()
    peers.homeRuntime.stopOrchestrationFederationRelay()
    vi.spyOn(peers.homeRuntime, 'callOrchestrationWorkerServer').mockRejectedValue(
      new Error('worker server offline')
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await peers.homeRuntime.syncOrchestrationFederation()
    await peers.homeRuntime.syncOrchestrationFederation()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Federation sync failed'),
      expect.any(Error)
    )
    warn.mockRestore()
  })

  it('returns stop_unknown when the worker server disconnects after the home fence', async () => {
    const task = peers.createHomeTask()
    await peers.homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = peers.homeDb.getDispatchContext(task.id)!
    const callWorker = peers.homeRuntime.callOrchestrationWorkerServer.bind(peers.homeRuntime)
    vi.spyOn(peers.homeRuntime, 'callOrchestrationWorkerServer').mockImplementation(
      async (...args) => {
        if (args[1] === 'orchestration.federationStop') {
          throw new Error('connection lost')
        }
        return callWorker(...args)
      }
    )

    const stopped = await peers.homeDispatcher.dispatch({
      id: 'rpc_disconnected_stop',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'request_disconnected_stop',
      method: 'orchestration.workerStop',
      params: { dispatch: dispatch.id }
    })

    expect(stopped).toMatchObject({
      ok: true,
      result: { state: 'stop_unknown', processAction: 'unknown' }
    })
    expect(peers.homeDb.getTask(task.id)?.status).toBe('blocked')
    expect(peers.workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('never reads or closes a same-looking replacement process', async () => {
    const task = peers.createHomeTask()
    await peers.homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = peers.homeDb.getDispatchContext(task.id)!
    vi.mocked(peers.workerRuntime.getTerminalProcessIncarnation).mockReturnValue(
      'windows_runtime:pty:replacement'
    )

    const read = await peers.homeDispatcher.dispatch({
      id: 'rpc_replacement_read',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatch.id }
    })
    const stopped = await peers.homeDispatcher.dispatch({
      id: 'rpc_replacement_stop',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'request_replacement_stop',
      method: 'orchestration.workerStop',
      params: { dispatch: dispatch.id }
    })

    expect(read).toMatchObject({
      ok: false,
      error: { code: 'worker_identity_changed' }
    })
    expect(stopped).toMatchObject({
      ok: true,
      result: { state: 'stop_unknown', processAction: 'none' }
    })
    expect(peers.workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })
})
