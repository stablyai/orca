import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createFederationWorkerStartRequest as startRequest } from './orchestration-federation-test-request'

describe('orchestration federation', () => {
  const databases: OrchestrationDb[] = []
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher
  let workerCapabilities: string[]
  let workerPeerFingerprint: string
  let loseNextAckResponse: boolean

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    databases.push(homeDb, workerDb)
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    workerDispatcher = new RpcDispatcher({
      runtime: workerRuntime,
      methods: ORCHESTRATION_METHODS
    })
    workerCapabilities = [...(workerRuntime.getStatus().capabilities ?? [])]
    workerPeerFingerprint = 'windows_peer_fingerprint'
    loseNextAckResponse = false
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_windows',
        name: 'windows',
        peerFingerprint: workerPeerFingerprint
      }),
      call: async (_selector, method, params, _timeoutMs, envelope) => {
        if (method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: { ...workerRuntime.getStatus(), capabilities: workerCapabilities },
            _meta: { runtimeId: workerRuntime.getRuntimeId() }
          }
        }
        const response = (await workerDispatcher.dispatch({
          id: `remote_${method}`,
          authToken: 'run-home-device-token',
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId,
          orchestrationCapability: envelope?.orchestrationCapability
        })) as RuntimeRpcResponse<unknown>
        if (method === 'orchestration.federationAck' && loseNextAckResponse) {
          loseNextAckResponse = false
          throw new Error('connection lost after acknowledgment')
        }
        return response
      }
    }
    homeRuntime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeDb)
    homeDispatcher = new RpcDispatcher({
      runtime: homeRuntime,
      methods: ORCHESTRATION_METHODS
    })
    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null
    )
    configureWorkerRuntime(workerRuntime)
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    for (const db of databases.splice(0)) {
      db.close()
    }
  })

  function createHomeTask() {
    const run = homeDb.createRun({
      objective: 'Mac to Windows',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    return homeDb.createTask({ spec: 'Audit Windows behavior', runId: run.id })
  }

  function configureWorkerRuntime(runtime: OrcaRuntimeService): void {
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'windows-repo',
      kind: 'git'
    } as never)
    vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
      worktree: { id: 'repo::windows-worktree', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_windows_worker' },
      setupReceipt: {
        requested: 'run',
        hookFound: true,
        startupPolicy: 'start-immediately',
        state: 'running'
      }
    } as never)
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [
        { handle: 'term_windows_worker', title: 'Codex' },
        { handle: 'term_windows_setup', title: 'Setup' }
      ],
      totalCount: 2,
      truncated: false
    } as never)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_windows_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(
      'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('windows_runtime:pty:1')
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_windows_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_windows_worker',
      worktreeId: 'repo::windows-worktree',
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_windows_worker',
      status: 'running',
      entries: [{ cursor: 1, text: 'remote output' }],
      nextCursor: '1',
      limited: false
    } as never)
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_windows_worker',
      closed: true
    } as never)
  }

  function restartWorkerRuntime(): void {
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    configureWorkerRuntime(workerRuntime)
    workerDispatcher = new RpcDispatcher({
      runtime: workerRuntime,
      methods: ORCHESTRATION_METHODS
    })
    workerCapabilities = [...(workerRuntime.getStatus().capabilities ?? [])]
  }

  it('starts a remote worker while keeping authoritative Task state at home', async () => {
    const task = createHomeTask()

    const response = await homeDispatcher.dispatch(startRequest(task.id))

    expect(response).toMatchObject({
      ok: true,
      result: {
        taskId: task.id,
        state: 'ready',
        server: { environmentId: 'environment_windows', name: 'windows' },
        setup: { source: 'orchestration_default' },
        mutation: { requestId: 'request_windows_worker' }
      }
    })
    const dispatch = homeDb.getDispatchContext(task.id)!
    expect(homeDb.getTask(task.id)?.status).toBe('dispatched')
    expect(homeDb.getFederatedDispatch(dispatch.id)).toMatchObject({
      environment_id: 'environment_windows',
      environment_name: 'windows',
      peer_fingerprint: 'windows_peer_fingerprint',
      remote_worktree_id: 'repo::windows-worktree',
      remote_terminal_handle: 'term_windows_worker'
    })
    const attachment = workerDb.getRemoteDispatchAttachment(dispatch.id)
    expect(attachment).toMatchObject({
      task_id: task.id,
      protocol_version: 3,
      state: 'ready',
      worktree_id: 'repo::windows-worktree',
      terminal_handle: 'term_windows_worker'
    })
    const fx = JSON.parse(attachment?.effects ?? '[]') as { kind?: string; state?: string }[]
    expect(fx.some((x) => x.kind === 'dispatch_input' && x.state === 'accepted')).toBe(true)
    expect(workerDb.listTasks()).toHaveLength(0)
    const create = vi.mocked(workerRuntime.createManagedWorktree).mock.calls[0]?.[0]
    expect([create.activate, create.runHooks]).toEqual([false, false])
    expect(workerRuntime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_windows_worker',
      expect.stringContaining(`Your task ID is: ${task.id}`)
    )
  })

  it('does not report remotely rejected preferences as effective', async () => {
    const task = createHomeTask()

    const response = await homeDispatcher.dispatch(
      startRequest(task.id, { agent: 'grok', model: 'unsupported-model' })
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        state: 'failed',
        launch: {
          requested: { agent: 'grok', model: 'unsupported-model', effort: null },
          effective: null
        }
      }
    })
  })

  it('preserves wait-for-setup gating on the connected worker server', async () => {
    vi.mocked(workerRuntime.createManagedWorktree).mockResolvedValueOnce({
      worktree: { id: 'repo::windows-worktree', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_windows_worker' },
      setupReceipt: {
        requested: 'run',
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'running'
      }
    } as never)
    const task = createHomeTask()

    const response = await homeDispatcher.dispatch(startRequest(task.id, { setup: 'run' }))

    expect(response).toMatchObject({
      ok: true,
      result: {
        state: 'ready',
        setup: { startupPolicy: 'wait-for-setup', state: 'succeeded' },
        effects: expect.arrayContaining([
          expect.objectContaining({ kind: 'setup', state: 'succeeded' }),
          expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
        ])
      }
    })
    expect(response).toHaveProperty('result.setup.source', 'explicit_request')
    expect(workerRuntime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
  })

  it('fails before remote task input when wait-for-setup fails', async () => {
    vi.mocked(workerRuntime.createManagedWorktree).mockResolvedValueOnce({
      worktree: { id: 'repo::windows-worktree', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_windows_worker' },
      setupReceipt: {
        requested: 'run',
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'running'
      }
    } as never)
    vi.mocked(workerRuntime.waitForTerminal).mockResolvedValueOnce({
      handle: 'term_windows_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'exited',
      exitCode: 1
    })
    const task = createHomeTask()

    const response = await homeDispatcher.dispatch(startRequest(task.id))

    expect(response).toMatchObject({
      ok: true,
      result: {
        state: 'failed',
        failedStage: 'setup_wait',
        setup: { state: 'failed' },
        effects: expect.arrayContaining([
          expect.objectContaining({ kind: 'setup', state: 'failed' })
        ])
      }
    })
    expect(homeDb.getTask(task.id)?.status).toBe('failed')
    expect(workerRuntime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('starts a legacy federation worker through its negotiated protocol', async () => {
    workerCapabilities = workerCapabilities.filter(
      (capability) => capability !== ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY
    )
    const task = createHomeTask()
    const started = await homeDispatcher.dispatch(startRequest(task.id))
    expect(started).toMatchObject({
      ok: true,
      result: { state: 'ready' }
    })
    const dispatch = homeDb.getDispatchContext(task.id)!

    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)).toMatchObject({
      state: 'ready',
      protocol_version: 1
    })
    expect(homeDb.listPendingFederationRelay(dispatch.id, 'to_worker')).toHaveLength(0)
    expect(workerRuntime.createManagedWorktree).toHaveBeenCalledOnce()
    expect(workerRuntime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
  })

  it('durably relays remote completion into the home Run and acknowledges it', async () => {
    const task = createHomeTask()
    const started = await homeDispatcher.dispatch(startRequest(task.id))
    expect(started.ok).toBe(true)
    const dispatch = homeDb.getDispatchContext(task.id)!
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    expect(capability).toBeTruthy()

    const sent = await workerDispatcher.dispatch({
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
          outcome: 'succeeded',
          filesModified: []
        })
      }
    })
    expect(sent).toMatchObject({ ok: true, result: { lifecycle: { action: 'completed' } } })
    expect(homeDb.getTask(task.id)?.status).toBe('completed')

    await homeRuntime.syncOrchestrationFederation()

    expect(homeDb.getTask(task.id)?.status).toBe('completed')
    expect(homeDb.getWorkerDispatch(dispatch.id)?.state).toBe('succeeded')
    expect(homeDb.getRunMailboxHistory(task.run_id, 10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^relay_/),
          type: 'worker_done',
          subject: 'Windows audit complete'
        })
      ])
    )
    expect(
      workerDb.listFederationRelay({
        dispatchId: dispatch.id,
        direction: 'to_home',
        afterSequence: 0
      })[0]
    ).toMatchObject({ acked_at: expect.any(String) })
  })

  it('relays a worker question home and the coordinator answer back', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    const ask = workerDispatcher.dispatch({
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
        workerDb.listFederationRelay({
          dispatchId: dispatch.id,
          direction: 'to_home',
          afterSequence: 0
        })
      ).toHaveLength(1)
    )

    await homeRuntime.syncOrchestrationFederation()
    const question = homeDb
      .getRunMailboxHistory(task.run_id, 10)
      .find((message) => message.type === 'question')
    expect(question).toMatchObject({
      body: 'Should I include slow integration tests?'
    })

    const reply = await homeDispatcher.dispatch({
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
    await homeRuntime.syncOrchestrationFederation()

    await expect(ask).resolves.toMatchObject({
      ok: true,
      result: {
        answer: 'yes',
        messageId: question!.id,
        timedOut: false
      }
    })
    expect(
      homeDb.listFederationRelay({
        dispatchId: dispatch.id,
        direction: 'to_worker',
        afterSequence: 0
      })[0]
    ).toMatchObject({ acked_at: expect.any(String) })
  })

  it('keeps a timed-out remote question resumable', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    const timedOut = await workerDispatcher.dispatch({
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

    await homeRuntime.syncOrchestrationFederation()
    await homeDispatcher.dispatch({
      id: 'rpc_home_late_reply',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'home_late_reply_request',
      method: 'orchestration.reply',
      params: { id: questionId, body: 'yes', from: 'term_coord' }
    })
    restartWorkerRuntime()
    const resumed = workerDispatcher.dispatch({
      id: 'rpc_remote_ask_resume',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_question_resume_request',
      orchestrationCapability: capability,
      method: 'orchestration.ask',
      params: { from: 'term_windows_worker', resume: questionId, timeoutMs: 5_000 }
    })
    await homeRuntime.syncOrchestrationFederation()

    await expect(resumed).resolves.toMatchObject({
      ok: true,
      result: { answer: 'yes', messageId: questionId, timedOut: false }
    })
  })

  it('retries a lost relay acknowledgment without duplicating the home message', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    await workerDispatcher.dispatch({
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
    loseNextAckResponse = true
    const remoteCall = vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer')

    await expect(homeRuntime.syncOrchestrationFederation()).resolves.toBeUndefined()
    await homeRuntime.syncOrchestrationFederation()

    expect(
      homeDb
        .getRunMailboxHistory(task.run_id, 10)
        .filter((message) => message.subject === 'Checkpoint')
    ).toHaveLength(1)
    const acknowledgments = remoteCall.mock.calls.filter(
      ([, method]) => method === 'orchestration.federationAck'
    )
    expect(acknowledgments).toHaveLength(2)
  })

  it('rejects a reordered relay gap, then converges without loss or duplication', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!

    expect(() =>
      homeDb.importFederatedRelayItem({
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
    expect(homeDb.getMessageById('relay_gap')).toBeUndefined()
    expect(homeDb.getFederatedDispatch(dispatch.id)?.to_home_imported_sequence).toBe(0)

    homeDb.importFederatedRelayItem({
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
    const recovered = homeDb.importFederatedRelayItem({
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
    const duplicate = homeDb.importFederatedRelayItem({
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
    expect(homeDb.getFederatedDispatch(dispatch.id)?.to_home_imported_sequence).toBe(2)
    expect(
      homeDb
        .getRunMailboxHistory(task.run_id, 10)
        .filter((message) => ['relay_first', 'relay_gap'].includes(message.id))
    ).toHaveLength(2)
  })

  it('restarts relay polling when a federated worker is shown', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    homeRuntime.stopOrchestrationFederationRelay()
    await workerDispatcher.dispatch({
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

    await homeDispatcher.dispatch({
      id: 'rpc_restart_show',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatch.id }
    })

    await vi.waitFor(() =>
      expect(
        homeDb
          .getRunMailboxHistory(task.run_id, 10)
          .some((message) => message.subject === 'After home restart')
      ).toBe(true)
    )
  })

  it('treats a worker runtime ID change as an epoch, not a new server', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    const oldEpoch = homeDb.getFederatedDispatch(dispatch.id)?.remote_runtime_epoch
    restartWorkerRuntime()

    const shown = await homeDispatcher.dispatch({
      id: 'rpc_worker_restart_show',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatch.id }
    })

    expect(shown).toMatchObject({
      ok: true,
      result: { observation: { status: 'running', exactWorker: true } }
    })
    expect(homeDb.getFederatedDispatch(dispatch.id)?.remote_runtime_epoch).not.toBe(oldEpoch)
    expect(homeDb.getFederatedDispatch(dispatch.id)?.peer_fingerprint).toBe(
      'windows_peer_fingerprint'
    )
  })

  it('stops only the exact remote agent terminal', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!

    const stopped = await homeDispatcher.dispatch({
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
    expect(workerRuntime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(workerRuntime.closeTerminal).toHaveBeenCalledWith('term_windows_worker')
    expect(homeDb.getTask(task.id)?.status).toBe('blocked')

    vi.mocked(workerRuntime.showTerminal).mockResolvedValue({
      handle: 'term_windows_worker',
      worktreeId: 'repo::windows-worktree',
      connected: false,
      writable: false
    } as never)
    const shown = await homeDispatcher.dispatch({
      id: 'rpc_remote_show_after_stop',
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
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    workerPeerFingerprint = 'replacement_windows_peer'

    const shown = await homeDispatcher.dispatch({
      id: 'rpc_changed_peer_show',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatch.id }
    })
    const stopped = await homeDispatcher.dispatch({
      id: 'rpc_changed_peer_stop',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'request_changed_peer_stop',
      method: 'orchestration.workerStop',
      params: { dispatch: dispatch.id }
    })

    expect(shown).toMatchObject({ ok: false, error: { code: 'peer_changed' } })
    expect(stopped).toMatchObject({ ok: false, error: { code: 'peer_changed' } })
    expect(homeDb.getWorkerDispatch(dispatch.id)?.state).toBe('ready')
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('coalesces overlapping relay polls for the same Dispatch', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    await homeRuntime.syncOrchestrationFederation()
    homeRuntime.stopOrchestrationFederationRelay()

    let releasePull!: () => void
    const blockedPull = new Promise<void>((resolve) => {
      releasePull = resolve
    })
    let pullCount = 0
    vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_selector, method) => {
        if (method !== 'orchestration.federationPull') {
          throw new Error(`Unexpected relay method ${method}`)
        }
        pullCount += 1
        await blockedPull
        return { runtimeEpoch: workerRuntime.getRuntimeId(), items: [] }
      }
    )

    const first = homeRuntime.syncOrchestrationFederation()
    const second = homeRuntime.syncOrchestrationFederation()
    await vi.waitFor(() => expect(pullCount).toBe(1))
    releasePull()
    await Promise.all([first, second])

    expect(pullCount).toBe(1)
  })

  it('warns once while a federated Dispatch remains unreachable', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    await homeRuntime.syncOrchestrationFederation()
    homeRuntime.stopOrchestrationFederationRelay()
    vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer').mockRejectedValue(
      new Error('worker server offline')
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await homeRuntime.syncOrchestrationFederation()
    await homeRuntime.syncOrchestrationFederation()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Federation sync failed'),
      expect.any(Error)
    )
    warn.mockRestore()
  })

  it('returns stop_unknown when the worker server disconnects after the home fence', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer').mockRejectedValueOnce(
      new Error('connection lost')
    )

    const stopped = await homeDispatcher.dispatch({
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
    expect(homeDb.getTask(task.id)?.status).toBe('blocked')
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('never reads or closes a same-looking replacement process', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    vi.mocked(workerRuntime.getTerminalProcessIncarnation).mockReturnValue(
      'windows_runtime:pty:replacement'
    )

    const read = await homeDispatcher.dispatch({
      id: 'rpc_replacement_read',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatch.id }
    })
    const stopped = await homeDispatcher.dispatch({
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
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })
})
