import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_ATTEMPT_BOUND_WORKER_LEASE_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { createFederationWorkerStartRequest as startRequest } from './federation-request.test-support'
import { createFederationPeers, type FederationPeers } from '../../orchestration-federation-peers'

describe('orchestration federation', () => {
  let peers: FederationPeers

  beforeEach(() => {
    peers = createFederationPeers()
  })

  afterEach(() => {
    peers.close()
  })

  it('starts a remote worker while keeping authoritative Task state at home', async () => {
    const task = peers.createHomeTask()

    const response = await peers.homeDispatcher.dispatch(startRequest(task.id))
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
    const dispatch = peers.homeDb.getDispatchContext(task.id)!
    expect(peers.homeDb.getTask(task.id)?.status).toBe('dispatched')
    expect(peers.homeDb.getFederatedDispatch(dispatch.id)).toMatchObject({
      environment_id: 'environment_windows',
      environment_name: 'windows',
      peer_fingerprint: 'windows_peer_fingerprint',
      remote_worktree_id: 'repo::windows-worktree',
      remote_terminal_handle: 'term_windows_worker'
    })
    expect(peers.homeDb.getDispatchContextById(dispatch.id)).toMatchObject({
      assignee_handle: 'term_windows_worker',
      assignee_pane_key: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      process_incarnation: 'windows_runtime:pty:1'
    })
    const attachment = peers.workerDb.getRemoteDispatchAttachment(dispatch.id)
    expect(attachment).toMatchObject({
      task_id: task.id,
      protocol_version: 4,
      state: 'ready',
      worktree_id: 'repo::windows-worktree',
      terminal_handle: 'term_windows_worker'
    })
    const fx = JSON.parse(attachment?.effects ?? '[]') as { kind?: string; state?: string }[]
    expect(fx.some((x) => x.kind === 'dispatch_input' && x.state === 'accepted')).toBe(true)
    expect(peers.workerDb.listTasks()).toHaveLength(0)
    const create = vi.mocked(peers.workerRuntime.createManagedWorktree).mock.calls[0]?.[0]
    expect([create.activate, create.runHooks]).toEqual([false, false])
    expect(peers.workerRuntime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_windows_worker',
      expect.stringContaining(`Your task ID is: ${task.id}`),
      expect.objectContaining({
        acceptQueued: true,
        observationTimeoutMs: 0,
        requestId: expect.any(String)
      })
    )
  })

  it('keeps a ready attachment without an exact terminal identity outcome_unknown', async () => {
    const task = peers.createHomeTask()
    const callWorkerServer = peers.homeRuntime.callOrchestrationWorkerServer.bind(peers.homeRuntime)
    vi.spyOn(peers.homeRuntime, 'callOrchestrationWorkerServer').mockImplementation(
      async (environmentId, method, params, timeoutMs, options) => {
        if (method === 'orchestration.federationAttachStart') {
          return {
            dispatchId: (params as { dispatchId: string }).dispatchId,
            state: 'ready',
            runtimeEpoch: peers.workerRuntime.getRuntimeId(),
            worktreeId: 'repo::windows-worktree',
            terminalHandle: 'term_windows_worker'
          }
        }
        return await callWorkerServer(environmentId, method, params, timeoutMs, options)
      }
    )

    const response = await peers.homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = peers.homeDb.getDispatchContext(task.id)!

    expect(response).toMatchObject({ ok: true, result: { state: 'outcome_unknown' } })
    expect(peers.homeDb.getWorkerDispatch(dispatch.id)).toMatchObject({ state: 'start_unknown' })
    expect(peers.homeDb.getDispatchContextById(dispatch.id)).toMatchObject({
      assignee_handle: null,
      assignee_pane_key: null,
      process_incarnation: null
    })
  })

  it('recovers exact attachment authority after the worker-start response is lost', async () => {
    vi.spyOn(peers.workerRuntime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'live',
      ptyIds: ['pty']
    })
    const task = peers.createHomeTask()
    peers.loseNextStartResponse = true

    const started = await peers.homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = peers.homeDb.getDispatchContext(task.id)!

    expect(started).toMatchObject({ ok: true, result: { state: 'outcome_unknown' } })
    expect(peers.homeDb.getWorkerDispatch(dispatch.id)).toMatchObject({ state: 'start_unknown' })
    expect(peers.homeDb.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'pending',
      assignee_handle: null,
      assignee_pane_key: null,
      process_incarnation: null
    })

    const recovered = await peers.homeDispatcher.dispatch({
      id: 'rpc_recover_lost_start',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      method: 'orchestration.workerShow',
      params: { dispatch: dispatch.id }
    })

    expect(recovered, JSON.stringify(recovered)).toMatchObject({
      ok: true,
      result: {
        worker: { state: 'ready' },
        observation: { status: 'live', exactWorker: true }
      }
    })
    expect(peers.homeDb.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'dispatched',
      assignee_handle: 'term_windows_worker',
      assignee_pane_key: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      process_incarnation: 'windows_runtime:pty:1'
    })
    expect(peers.homeDb.getFederatedDispatch(dispatch.id)).toMatchObject({
      remote_runtime_epoch: peers.workerRuntime.getRuntimeId(),
      remote_worktree_id: 'repo::windows-worktree',
      remote_terminal_handle: 'term_windows_worker'
    })
    expect(() =>
      peers.homeDb.updateFederatedDispatchResources({
        dispatchId: dispatch.id,
        remoteRuntimeEpoch: peers.workerRuntime.getRuntimeId(),
        worktreeId: 'repo::windows-worktree',
        terminalHandle: 'term_replacement_worker',
        paneKey: 'tab_worker:replacement',
        processIncarnation: 'windows_runtime:pty:replacement'
      })
    ).toThrow('already bound to different remote resources')
    expect(peers.homeDb.getDispatchContextById(dispatch.id)).toMatchObject({
      assignee_handle: 'term_windows_worker',
      assignee_pane_key: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      process_incarnation: 'windows_runtime:pty:1'
    })
  })

  it('does not report remotely rejected preferences as effective', async () => {
    const task = peers.createHomeTask()

    const response = await peers.homeDispatcher.dispatch(
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

  it('carries an explicit worker label as user display-name provenance', async () => {
    const task = peers.createHomeTask()

    await peers.homeDispatcher.dispatch(
      startRequest(task.id, { displayName: 'Windows release audit' })
    )

    expect(peers.workerRuntime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'Windows release audit',
        displayNameKind: 'user'
      })
    )
  })

  it('bounds and redacts an older peer raw lastError instead of relaying it verbatim', async () => {
    const task = peers.createHomeTask()
    const realCall = peers.homeRuntime.callOrchestrationWorkerServer.bind(peers.homeRuntime)
    vi.spyOn(peers.homeRuntime, 'callOrchestrationWorkerServer').mockImplementation(
      async (environmentId, method, params, timeoutMs, options) => {
        if (method !== 'orchestration.federationAttachStart') {
          return realCall(environmentId, method, params, timeoutMs, options)
        }
        // Why: simulates an older worker peer that predates redaction —
        // its raw RPC response carries a secret and no stage label at all.
        return {
          dispatchId: (params as { dispatchId: string }).dispatchId,
          state: 'failed',
          runtimeEpoch: 'legacy-worker-runtime',
          failedStage: 'agent_readiness',
          lastError: 'exec failed: token=abc123def456 and Bearer sk-oldpeerkey1234567890',
          setup: { state: 'not_applicable' },
          effects: [],
          residualResources: []
        }
      }
    )

    const response = await peers.homeDispatcher.dispatch(startRequest(task.id))

    expect(response).toMatchObject({ ok: true, result: { state: 'failed' } })
    const lastError = (response as { result: { lastError?: string } }).result.lastError
    expect(lastError).toBeDefined()
    expect((response as { result: { failedStage?: string } }).result.failedStage).toBe(
      'agent_readiness'
    )
    expect(lastError).not.toContain('abc123def456')
    expect(lastError).not.toContain('sk-oldpeerkey1234567890')
  })

  it('rejects a reused-terminal worker start with incompatible model/effort before any remote dispatch', async () => {
    const task = peers.createHomeTask()
    const callSpy = vi.spyOn(peers.homeRuntime, 'callOrchestrationWorkerServer')

    const response = await peers.homeDispatcher.dispatch(
      startRequest(task.id, { terminal: 'term_existing_windows_worker', model: 'sonnet' })
    )

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: expect.stringContaining('reusing an existing terminal')
      }
    })
    // Why: the incompatibility must be rejected before status.get or any other
    // remote call — a reused terminal can never actually apply a model/effort
    // override, so the request must never reach the worker server at all.
    expect(callSpy).not.toHaveBeenCalled()
    expect(peers.workerDb.listTasks()).toHaveLength(0)
  })

  it('preserves wait-for-setup gating on the connected worker server', async () => {
    vi.mocked(peers.workerRuntime.createManagedWorktree).mockResolvedValueOnce({
      worktree: { id: 'repo::windows-worktree', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_windows_worker' },
      setupReceipt: {
        requested: 'run',
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'running'
      }
    } as never)
    const task = peers.createHomeTask()

    const response = await peers.homeDispatcher.dispatch(startRequest(task.id, { setup: 'run' }))

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
    expect(peers.workerRuntime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
  })

  it('fails before remote task input when wait-for-setup fails', async () => {
    vi.mocked(peers.workerRuntime.createManagedWorktree).mockResolvedValueOnce({
      worktree: { id: 'repo::windows-worktree', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_windows_worker' },
      setupReceipt: {
        requested: 'run',
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'running'
      }
    } as never)
    vi.mocked(peers.workerRuntime.waitForTerminal).mockResolvedValueOnce({
      handle: 'term_windows_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'exited',
      exitCode: 1
    })
    const task = peers.createHomeTask()

    const response = await peers.homeDispatcher.dispatch(startRequest(task.id))

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
    expect(peers.homeDb.getTask(task.id)?.status).toBe('failed')
    expect(peers.workerRuntime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  // Why: mixed versions are the normal state. A peer without attempt-bound leases
  // is negotiated down, not refused, and the attachment it records must name the
  // version actually spoken — never claim a lease the peer cannot carry.
  it('negotiates down for a peer without attempt-bound worker leases', async () => {
    peers.workerCapabilities = peers.workerCapabilities.filter(
      (capability) =>
        capability !== ORCHESTRATION_FEDERATION_ATTEMPT_BOUND_WORKER_LEASE_RUNTIME_CAPABILITY
    )
    const task = peers.createHomeTask()
    const started = await peers.homeDispatcher.dispatch(startRequest(task.id))
    expect(started).toMatchObject({ ok: true, result: { state: 'ready' } })
    const dispatch = peers.homeDb.getDispatchContext(task.id)!
    expect(peers.workerDb.getRemoteDispatchAttachment(dispatch.id)?.protocol_version).toBe(3)
    expect(peers.workerDb.getMaestroTerminalLeaseByHandle('term_windows_worker')).toBeUndefined()
  })

  it('releases the exact remote attachment after a worker runtime reconnect', async () => {
    const task = peers.createHomeTask()
    const started = await peers.homeDispatcher.dispatch(startRequest(task.id))
    expect(started).toMatchObject({ ok: true, result: { state: 'ready' } })
    const dispatch = peers.homeDb.getDispatchContext(task.id)!
    const attachedEpoch = peers.homeDb.getFederatedDispatch(dispatch.id)?.remote_runtime_epoch
    peers.workerDb.settleRemoteAttachmentInRelayTransaction(dispatch.id, 'succeeded')

    peers.restartWorkerRuntime()
    vi.spyOn(peers.workerRuntime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'live',
      ptyIds: ['pty_windows_worker']
    })

    const released = await peers.homeDispatcher.dispatch({
      id: 'rpc_release_after_worker_reconnect',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'release_after_worker_reconnect',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatch.id }
    })

    expect(peers.workerRuntime.getRuntimeId()).not.toBe(attachedEpoch)
    expect(released).toMatchObject({
      ok: true,
      result: { state: 'released', processAction: 'closed_agent_terminal' }
    })
    expect(peers.workerRuntime.closeTerminal).toHaveBeenCalledOnce()
  })

  it('rejects federated retry before dispatch creation or attachment', async () => {
    const task = peers.createHomeTask()
    const callSpy = vi.spyOn(peers.homeRuntime, 'callOrchestrationWorkerServer')

    const response = await peers.homeDispatcher.dispatch(
      startRequest(task.id, { retryOf: 'ctx_previous' })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'capability_unsupported' } })
    expect(peers.homeDb.getDispatchContext(task.id)).toBeUndefined()
    expect(callSpy).not.toHaveBeenCalled()
    expect(peers.workerRuntime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('rejects a v4 attachment without authoritative run identity before effects', async () => {
    const response = await peers.workerDispatcher.dispatch({
      id: 'rpc_direct_v4_missing_run',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'direct_v4_missing_run',
      method: 'orchestration.federationAttachStart',
      params: {
        dispatchId: 'ctx_direct',
        taskId: 'task_direct',
        attemptId: 'attempt_direct',
        taskSpec: 'must not attach',
        protocolVersion: 4,
        worktree: 'new-top-level',
        repo: 'id:windows-repo',
        name: 'blocked',
        agent: 'codex'
      }
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(peers.workerDb.getRemoteDispatchAttachment('ctx_direct')).toBeUndefined()
    expect(
      peers.workerDb.getMaestroTerminalLeaseByRequest('federated-worker:ctx_direct')
    ).toBeUndefined()
    expect(peers.workerRuntime.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('preflights the remote executable before attachment or worktree effects', async () => {
    vi.spyOn(peers.workerRuntime, 'preflightWorktreeManagedCliExecutable').mockImplementation(
      () => {
        throw new Error('managed cli unavailable')
      }
    )
    const response = await peers.workerDispatcher.dispatch({
      id: 'rpc_direct_v4_preflight',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'direct_v4_preflight',
      method: 'orchestration.federationAttachStart',
      params: {
        dispatchId: 'ctx_preflight',
        taskId: 'task_preflight',
        attemptId: 'attempt_preflight',
        runId: 'run_preflight',
        coordinatorGeneration: 1,
        taskSpec: 'must not attach',
        protocolVersion: 4,
        worktree: 'new-top-level',
        repo: 'id:windows-repo',
        name: 'blocked',
        agent: 'codex'
      }
    })

    expect(response).toMatchObject({ ok: false })
    expect(peers.workerDb.getRemoteDispatchAttachment('ctx_preflight')).toBeUndefined()
    expect(
      peers.workerDb.getMaestroTerminalLeaseByRequest('federated-worker:ctx_preflight')
    ).toBeUndefined()
    expect(peers.workerRuntime.createManagedWorktree).not.toHaveBeenCalled()
  })
})
