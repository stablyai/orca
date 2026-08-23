import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_WORKER_RELEASE_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createFederationWorkerStartRequest } from './orchestration-federation-test-request'
import { configureFederationTestRuntime } from './orchestration-federation-test-runtime'

describe('orchestration federated terminal lifecycle', () => {
  const databases: OrchestrationDb[] = []
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher
  let workerCapabilities: string[]

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    databases.push(homeDb, workerDb)
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    workerDispatcher = new RpcDispatcher({ runtime: workerRuntime, methods: ORCHESTRATION_METHODS })
    workerCapabilities = [...(workerRuntime.getStatus().capabilities ?? [])]
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_windows',
        name: 'windows',
        peerFingerprint: 'windows_peer_fingerprint'
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
        return (await workerDispatcher.dispatch({
          id: `remote_${method}`,
          authToken: 'run-home-device-token',
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId,
          orchestrationCapability: envelope?.orchestrationCapability
        })) as RuntimeRpcResponse<unknown>
      }
    }
    homeRuntime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeDb)
    homeDispatcher = new RpcDispatcher({ runtime: homeRuntime, methods: ORCHESTRATION_METHODS })
    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null
    )
    configureFederationTestRuntime(workerRuntime)
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    for (const db of databases.splice(0)) {
      db.close()
    }
  })

  async function createSettledWorker(requestId: string) {
    const run = homeDb.createRun({
      objective: 'Windows to WSL lifecycle',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = homeDb.createTask({ spec: 'Run lifecycle oracle', runId: run.id })
    await homeDispatcher.dispatch(createFederationWorkerStartRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls.at(-1)?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    const sent = await workerDispatcher.dispatch({
      id: `rpc_${requestId}`,
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: requestId,
      orchestrationCapability: capability,
      method: 'orchestration.send',
      params: {
        from: 'term_windows_worker',
        subject: 'Remote worker complete',
        body: 'STA4593_REMOTE_ARCHIVE_MARKER',
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
    await homeRuntime.syncOrchestrationFederation()
    return { dispatchId: dispatch.id }
  }

  it('releases and reads a settled worker through its owning server', async () => {
    const { dispatchId } = await createSettledWorker('release_worker_done_request')
    expect(homeDb.getWorkerTerminalResourceByOwner(dispatchId)).toBeUndefined()
    expect(workerDb.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      terminal_handle: 'term_windows_worker',
      pane_key: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      process_incarnation: 'windows_runtime:pty:1',
      ownership_state: 'owned',
      release_state: 'not_requested'
    })
    const shown = await homeDispatcher.dispatch({
      id: 'rpc_federated_worker_show',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatchId }
    })
    expect(shown).toMatchObject({
      ok: true,
      result: {
        terminalResource: {
          ownershipState: 'owned',
          releaseState: 'not_requested',
          terminalHandle: 'term_windows_worker'
        }
      }
    })
    expect(
      (shown as { result: { terminalResource: Record<string, unknown> } }).result.terminalResource
    ).not.toHaveProperty('ownership_state')
    const releaseRequest = {
      id: 'rpc_federated_release',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'federated_release_request',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    } as const

    const released = await homeDispatcher.dispatch(releaseRequest)
    const replayed = await homeDispatcher.dispatch(releaseRequest)
    const alreadyReleased = await homeDispatcher.dispatch({
      ...releaseRequest,
      id: 'rpc_federated_release_retry',
      orchestrationRequestId: 'federated_release_retry_request'
    })
    const read = await homeDispatcher.dispatch({
      id: 'rpc_released_worker_read',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId }
    })

    expect(released).toMatchObject({
      ok: true,
      result: {
        dispatchId,
        state: 'released',
        processAction: 'closed_agent_terminal',
        archive: { source: 'terminal', status: 'captured' }
      }
    })
    expect(replayed).toMatchObject({
      ok: true,
      result: { state: 'released', mutation: { replayed: true } }
    })
    expect(alreadyReleased).toMatchObject({
      ok: true,
      result: { state: 'already_released', processAction: 'none' }
    })
    expect(workerRuntime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(workerRuntime.closeTerminal).toHaveBeenCalledWith('term_windows_worker')
    expect(workerDb.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released'
    })
    expect(read).toMatchObject({
      ok: true,
      result: {
        archived: true,
        source: 'terminal',
        terminal: {
          handle: 'term_windows_worker',
          status: 'exited',
          exitCode: 17,
          command: 'python sta4593-oracle.py',
          tail: ['STA4593_REMOTE_ARCHIVE_MARKER']
        }
      }
    })
  })

  it('retains a federated worker when its server lacks release support', async () => {
    const { dispatchId } = await createSettledWorker('unsupported_worker_done_request')
    workerCapabilities = workerCapabilities.filter(
      (capability) => capability !== ORCHESTRATION_FEDERATION_WORKER_RELEASE_RUNTIME_CAPABILITY
    )

    const released = await homeDispatcher.dispatch({
      id: 'rpc_unsupported_federated_release',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'unsupported_federated_release_request',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })

    expect(released).toMatchObject({
      ok: true,
      result: {
        state: 'retained',
        reason: 'federation_unsupported',
        processAction: 'none'
      }
    })
    expect(workerDb.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'not_requested'
    })
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('preserves contract migration errors instead of reporting transport loss', async () => {
    const { dispatchId } = await createSettledWorker('migration_worker_done_request')
    workerCapabilities = workerCapabilities.filter(
      (capability) => capability !== ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY
    )

    const released = await homeDispatcher.dispatch({
      id: 'rpc_migration_federated_release',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'migration_federated_release_request',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })

    expect(released).toMatchObject({
      ok: false,
      error: { code: 'orchestration_migration_required' }
    })
  })

  it('releases an exited worker from its retained execution-host identity', async () => {
    const { dispatchId } = await createSettledWorker('exited_worker_done_request')
    vi.mocked(workerRuntime.getOrchestrationDispatchAuthority).mockReturnValue(null)
    vi.spyOn(workerRuntime, 'getTerminalExecutionHostScope').mockReturnValue({
      kind: 'local',
      hostId: 'local'
    })
    vi.mocked(workerRuntime.showTerminal).mockResolvedValue({
      handle: 'term_windows_worker',
      worktreeId: 'repo::windows-worktree',
      connected: false
    } as never)

    const released = await homeDispatcher.dispatch({
      id: 'rpc_exited_federated_release',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'exited_federated_release_request',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })

    expect(released).toMatchObject({
      ok: true,
      result: { state: 'released', processAction: 'closed_exited_terminal' }
    })
    expect(workerRuntime.closeTerminal).toHaveBeenCalledOnce()
  })

  it('lets retain cancel a federated release before archive commit', async () => {
    const { dispatchId } = await createSettledWorker('racing_worker_done_request')
    let captureStarted!: () => void
    let finishCapture!: () => void
    const started = new Promise<void>((resolve) => {
      captureStarted = resolve
    })
    const captureBarrier = new Promise<void>((resolve) => {
      finishCapture = resolve
    })
    vi.mocked(workerRuntime.readTerminal).mockImplementationOnce(async () => {
      captureStarted()
      await captureBarrier
      return {
        handle: 'term_windows_worker',
        status: 'running',
        tail: ['STA4593_RACE_MARKER'],
        truncated: false,
        nextCursor: '1'
      }
    })
    const releasing = homeDispatcher.dispatch({
      id: 'rpc_racing_federated_release',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'racing_federated_release_request',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    await started
    const retained = await homeDispatcher.dispatch({
      id: 'rpc_racing_federated_retain',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'racing_federated_retain_request',
      method: 'orchestration.workerRetain',
      params: { dispatch: dispatchId }
    })
    finishCapture()

    await expect(releasing).resolves.toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'user_requested', processAction: 'none' }
    })
    expect(retained).toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'user_requested', processAction: 'none' }
    })
    expect(workerDb.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'retained',
      retained_reason: 'user_requested'
    })
    expect(workerDb.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })
})
