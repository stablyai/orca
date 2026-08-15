import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import { syncFederatedDispatch } from '../../orchestration/federation-sync'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { reconcileWorkerDeadlines } from '../../orchestration/worker-deadline-reconciler'
import { reconcileRequestedWorkerTerminalReleases } from '../../orchestration/worker-terminal-release-reconciliation'
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
    vi.spyOn(runtime, 'createBoundedWorkerTerminal').mockResolvedValue({
      handle: 'term_windows_worker',
      worktreeId: 'repo::windows-worktree',
      title: 'worker',
      watchdogSentinelPath: '/tmp/orca-test-worker-watchdog-sentinel.json'
    })
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
    vi.spyOn(runtime, 'waitForSetupTerminalCompletion').mockResolvedValue({ exitCode: 0 })
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
      tail: ['remote output'],
      truncated: false,
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

  async function completeRemoteTask(task: ReturnType<typeof createHomeTask>): Promise<string> {
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls.at(-1)?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    expect(capability).toBeTruthy()
    await workerDispatcher.dispatch({
      id: `rpc_worker_done_${dispatch.id}`,
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: `worker_done_${dispatch.id}`,
      orchestrationCapability: capability,
      method: 'orchestration.send',
      params: {
        from: 'term_windows_worker',
        subject: 'Windows audit complete',
        body: 'Audited Windows behavior. Nothing remains.',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded',
          filesModified: []
        })
      }
    })
    await syncFederatedDispatch(homeRuntime, dispatch.id)
    return dispatch.id
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
        budget: { group: 'federation-test', maxRuntimeMs: 60_000, maxRequests: 10 },
        leafControl: {
          leaf: true,
          enforcement: 'environment_and_cli'
        },
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
      protocol_version: 2,
      state: 'ready',
      worktree_id: 'repo::windows-worktree',
      terminal_handle: 'term_windows_worker',
      max_requests: 10,
      watchdog_sentinel_path: workerRuntime.getWorkerWatchdogSentinelPath(dispatch.id)
    })
    expect(attachment?.deadline_at).toBe(homeDb.getWorkerDispatch(dispatch.id)?.deadline_at)
    const fx = JSON.parse(attachment?.effects ?? '[]') as { kind?: string; state?: string }[]
    expect(fx.some((x) => x.kind === 'dispatch_input' && x.state === 'accepted')).toBe(true)
    expect(workerDb.listTasks()).toHaveLength(0)
    const create = vi.mocked(workerRuntime.createManagedWorktree).mock.calls[0]?.[0]
    expect([create.activate, create.runHooks]).toEqual([false, false])
    expect(create.startupAgent).toBeUndefined()
    expect(workerRuntime.createBoundedWorkerTerminal).toHaveBeenCalledWith(
      'id:repo::windows-worktree',
      expect.objectContaining({
        dispatchId: dispatch.id,
        agent: 'codex',
        deadlineAt: attachment?.deadline_at,
        maxRequests: 10,
        surfaceOwner: false
      })
    )
    expect(workerRuntime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_windows_worker',
      expect.stringContaining(`Your task ID is: ${task.id}`)
    )
  })

  it('does not report remotely rejected preferences as effective', async () => {
    const task = createHomeTask()

    const response = await homeDispatcher.dispatch(
      startRequest(task.id, {
        agent: 'claude',
        model: 'unsupported-model',
        effort: 'unsupported-effort'
      })
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        state: 'failed',
        launch: {
          requested: {
            agent: 'claude',
            model: 'unsupported-model',
            effort: 'unsupported-effort'
          },
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
        state: 'running',
        terminalHandle: 'term_windows_setup'
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
        state: 'running',
        terminalHandle: 'term_windows_setup'
      }
    } as never)
    vi.mocked(workerRuntime.waitForSetupTerminalCompletion).mockResolvedValueOnce({ exitCode: 1 })
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
    expect(workerRuntime.createBoundedWorkerTerminal).not.toHaveBeenCalled()
    expect(workerRuntime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('rejects control mail before queueing when the worker lacks that capability', async () => {
    workerCapabilities = workerCapabilities.filter(
      (capability) => capability !== ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY
    )
    const task = createHomeTask()
    const started = await homeDispatcher.dispatch(startRequest(task.id))
    expect(started).toMatchObject({ ok: true, result: { state: 'ready' } })
    const dispatch = homeDb.getDispatchContext(task.id)!

    const sent = await homeDispatcher.dispatch({
      id: 'send-control-to-old-worker',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'send-control-to-old-worker-request',
      method: 'orchestration.send',
      params: {
        from: 'term_coord',
        to: `dispatch:${dispatch.id}`,
        subject: 'Continue',
        body: 'This worker cannot receive control mail yet.',
        type: 'status'
      }
    })

    expect(sent).toMatchObject({
      ok: false,
      error: { code: 'capability_unsupported' }
    })
    expect(homeDb.listPendingFederationRelay(dispatch.id, 'to_worker')).toHaveLength(0)
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
    expect(sent).toMatchObject({
      ok: true,
      result: { relay: { dispatchId: dispatch.id, accepted: true } }
    })
    expect(homeDb.getTask(task.id)?.status).toBe('dispatched')

    await syncFederatedDispatch(homeRuntime, dispatch.id)

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

  it('preserves a remote watchdog stop that lands during startup', async () => {
    const task = createHomeTask()
    let resolveReadiness!: (value: {
      handle: string
      condition: 'tui-idle'
      satisfied: boolean
      status: 'running'
      exitCode: null
    }) => void
    vi.mocked(workerRuntime.waitForTerminal).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReadiness = resolve
        }) as never
    )
    const starting = homeDispatcher.dispatch(startRequest(task.id))
    await vi.waitFor(() =>
      expect(
        workerDb.getRemoteDispatchAttachment(homeDb.getDispatchContext(task.id)!.id)
      ).toBeTruthy()
    )
    const dispatchId = homeDb.getDispatchContext(task.id)!.id
    const attachment = workerDb.getRemoteDispatchAttachment(dispatchId)!
    workerDb.reconcileRemoteWorkerWatchdogSentinel(dispatchId, {
      dispatchId,
      startedAt: '2026-08-15T00:00:00.000Z',
      deadlineAt: attachment.deadline_at,
      finishedAt: '2026-08-15T00:00:02.000Z',
      exitCode: null,
      signal: 'SIGKILL',
      stop: 'kill'
    })
    resolveReadiness({
      handle: 'term_windows_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null
    })

    await expect(starting).resolves.toMatchObject({
      ok: true,
      result: { dispatchId, state: 'stopped', stage: 'runtime_budget_exhausted' }
    })
    expect(homeDb.getWorkerDispatch(dispatchId)?.state).toBe('stopped')
    expect(homeDb.getTask(task.id)?.status).toBe('blocked')
  })

  it('routes settled worker release to the pinned server and stays idempotent', async () => {
    const task = createHomeTask()
    const dispatchId = await completeRemoteTask(task)

    const released = await homeDispatcher.dispatch({
      id: 'rpc_remote_release',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_request',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    expect(released).toMatchObject({
      ok: true,
      result: {
        dispatchId,
        state: 'released',
        processAction: 'closed_agent_terminal'
      }
    })
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.stage).toBe('released')
    expect(workerDb.getWorkerTerminalArchive(dispatchId)).toMatchObject({
      kind: 'terminal_tail',
      content: expect.stringContaining('remote output')
    })

    const duplicate = await homeDispatcher.dispatch({
      id: 'rpc_remote_release_duplicate',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_request_duplicate',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    expect(duplicate).toMatchObject({
      ok: true,
      result: { dispatchId, state: 'already_released', processAction: 'none' }
    })
    expect(workerRuntime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('respects user takeover instead of closing a remote terminal', async () => {
    const task = createHomeTask()
    const dispatchId = await completeRemoteTask(task)
    expect(
      workerDb.markWorkerTerminalUserOwned('tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    ).toBe(1)

    const retained = await homeDispatcher.dispatch({
      id: 'rpc_remote_release_takeover',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_takeover',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })

    expect(retained).toMatchObject({
      ok: true,
      result: {
        dispatchId,
        state: 'retained',
        reason: 'user_takeover',
        processAction: 'none'
      }
    })
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.stage).not.toBe('released')
  })

  it('records explicit retention on the pinned worker server', async () => {
    const task = createHomeTask()
    const dispatchId = await completeRemoteTask(task)

    const retained = await homeDispatcher.dispatch({
      id: 'rpc_remote_retain',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_retain',
      method: 'orchestration.workerRetain',
      params: { dispatch: dispatchId }
    })

    expect(retained).toMatchObject({
      ok: true,
      result: { dispatchId, state: 'retained', reason: 'user_requested' }
    })
    expect(workerDb.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'retained',
      retained_reason: 'user_requested'
    })
  })

  it('coalesces concurrent remote release requests', async () => {
    const task = createHomeTask()
    const dispatchId = await completeRemoteTask(task)
    let releaseArchive!: () => void
    vi.mocked(workerRuntime.readTerminal).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseArchive = () =>
            resolve({
              handle: 'term_windows_worker',
              status: 'running',
              tail: ['remote output'],
              truncated: false,
              entries: [{ cursor: 1, text: 'remote output' }],
              nextCursor: '1',
              limited: false
            } as never)
        })
    )

    const first = homeDispatcher.dispatch({
      id: 'rpc_remote_release_concurrent_1',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_concurrent_1',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    await vi.waitFor(() => expect(workerRuntime.readTerminal).toHaveBeenCalled())
    const second = homeDispatcher.dispatch({
      id: 'rpc_remote_release_concurrent_2',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_concurrent_2',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    releaseArchive()

    const receipts = await Promise.all([first, second])
    expect(receipts).toEqual([
      expect.objectContaining({ ok: true, result: expect.objectContaining({ state: 'released' }) }),
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ state: 'already_released' })
      })
    ])
    expect(workerRuntime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('retries durable remote release intent after worker runtime restart', async () => {
    const task = createHomeTask()
    const dispatchId = await completeRemoteTask(task)
    vi.mocked(workerRuntime.closeTerminal).mockRejectedValueOnce(
      new Error('runtime stopped during close')
    )

    const interrupted = await homeDispatcher.dispatch({
      id: 'rpc_remote_release_interrupted',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_interrupted',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    expect(interrupted).toMatchObject({
      ok: true,
      result: { dispatchId, state: 'release_unknown', processAction: 'none' }
    })
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.stage).not.toBe('released')
    await expect(
      workerDispatcher.dispatch({
        id: 'rpc_remote_release_unknown_output',
        authToken: 'run-home-device-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        method: 'orchestration.federationReadOutput',
        params: { dispatchId }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: { output: { terminal: { tail: ['remote output'] } } }
    })

    restartWorkerRuntime()
    await expect(reconcileRequestedWorkerTerminalReleases(workerRuntime)).resolves.toMatchObject({
      released: 1
    })
    const recovered = await homeDispatcher.dispatch({
      id: 'rpc_remote_release_recovered',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_recovered',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    expect(recovered).toMatchObject({
      ok: true,
      result: { dispatchId, state: 'already_released', processAction: 'none' }
    })
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.stage).toBe('released')
  })

  it('preserves mixed-version federated terminals when managed release is unavailable', async () => {
    const task = createHomeTask()
    const dispatchId = await completeRemoteTask(task)
    vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer').mockRejectedValueOnce(
      new OrchestrationError(
        'orchestration_migration_required',
        'worker server uses the prior contract'
      )
    )

    const retained = await homeDispatcher.dispatch({
      id: 'rpc_remote_release_v1',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_v1',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })

    expect(retained).toMatchObject({
      ok: true,
      result: {
        dispatchId,
        state: 'retained',
        reason: 'ownership_transferred',
        processAction: 'none'
      }
    })
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('does not claim remote release across a disconnect and permits a retry', async () => {
    const task = createHomeTask()
    const dispatchId = await completeRemoteTask(task)
    vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer').mockRejectedValueOnce(
      new Error('worker server disconnected before release')
    )

    const disconnected = await homeDispatcher.dispatch({
      id: 'rpc_remote_release_disconnected',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_disconnected',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    expect(disconnected).toMatchObject({ ok: false })
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.stage).not.toBe('released')
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()

    const retried = await homeDispatcher.dispatch({
      id: 'rpc_remote_release_retried',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_retried',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    expect(retried).toMatchObject({
      ok: true,
      result: { dispatchId, state: 'released', processAction: 'closed_agent_terminal' }
    })
  })

  it('relays a remote watchdog deadline failure home without creating a replacement Dispatch', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const original = homeDb.getDispatchContext(task.id)!
    const attachment = workerDb.getRemoteDispatchAttachment(original.id)!
    const payload = {
      dispatchId: original.id,
      startedAt: '2026-08-15T00:00:00.000Z',
      deadlineAt: attachment.deadline_at,
      finishedAt: '2026-08-15T00:00:02.000Z',
      exitCode: null,
      signal: 'SIGTERM',
      stop: 'term'
    }

    await reconcileWorkerDeadlines(workerDb, {
      readFileImpl: async () => JSON.stringify(payload) as never
    })
    expect(
      workerDb.listFederationRelay({
        dispatchId: original.id,
        direction: 'to_home',
        afterSequence: 0
      })[0]?.payload
    ).toContain('runtime_budget_exhausted:term')
    const synced = await syncFederatedDispatch(homeRuntime, original.id)
    expect(synced.imported).toBe(1)

    expect(homeDb.getDispatchContext(task.id)?.id).toBe(original.id)
    expect(homeDb.getTask(task.id)).toMatchObject({
      status: 'blocked',
      result: expect.stringContaining('runtime_budget_exhausted:term')
    })
    expect(workerDb.getRemoteDispatchAttachment(original.id)).toMatchObject({
      state: 'stopped',
      stage: 'runtime_budget_exhausted'
    })
  })
})
