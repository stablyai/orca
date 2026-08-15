import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import { syncFederatedDispatch } from '../../orchestration/federation-sync'
import { OrchestrationError } from '../../orchestration/orchestration-error'
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
})
