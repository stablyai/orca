import { expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../../../shared/runtime-rpc-envelope'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { reconcileRequestedWorkerTerminalReleases } from '../../../../orchestration/worker-terminal-release-reconciliation'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcRequest } from '../../../core'

type RecoveryScenarioHarness = {
  startSettledRemoteWorker: () => Promise<string>
  dispatch: (request: RpcRequest) => Promise<RuntimeRpcResponse<unknown>>
  runtime: () => OrcaRuntimeService
  homeDb: () => OrchestrationDb
  workerDb: () => OrchestrationDb
  setWorkerTerminalAvailable: (available: boolean) => void
  restartWorkerRuntime: (preserveMissingTerminal?: boolean) => void
}

export function registerFederatedReleaseRecoveryScenarios(harness: RecoveryScenarioHarness): void {
  it('reconciles a remote release intent after restart and replays idempotently', async () => {
    const dispatchId = await harness.startSettledRemoteWorker()
    expect(harness.workerDb().requestRemoteAttachmentTerminalRelease(dispatchId)).toMatchObject({
      disposition: 'requested',
      resource: { release_state: 'requested' }
    })

    harness.setWorkerTerminalAvailable(false)
    harness.restartWorkerRuntime(true)
    const restartedRuntime = harness.runtime()
    await expect(reconcileRequestedWorkerTerminalReleases(restartedRuntime)).resolves.toMatchObject(
      {
        attempted: 1,
        released: 0,
        pending: 1,
        unknown: 0,
        retained: 0
      }
    )
    expect(restartedRuntime.closeTerminal).not.toHaveBeenCalled()
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'requested',
      ownership_state: 'owned'
    })

    harness.setWorkerTerminalAvailable(true)
    await expect(reconcileRequestedWorkerTerminalReleases(restartedRuntime)).resolves.toMatchObject(
      {
        attempted: 1,
        released: 1,
        pending: 0,
        unknown: 0,
        retained: 0
      }
    )
    expect(restartedRuntime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(harness.workerDb().getRemoteDispatchAttachment(dispatchId)).toMatchObject({
      stage: 'released'
    })
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'released',
      ownership_state: 'released'
    })

    await expect(reconcileRequestedWorkerTerminalReleases(restartedRuntime)).resolves.toMatchObject(
      {
        attempted: 0,
        released: 0
      }
    )
    expect(restartedRuntime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('keeps a transient remote close failure pending for automatic reconciliation', async () => {
    const dispatchId = await harness.startSettledRemoteWorker()
    vi.mocked(harness.runtime().closeTerminal).mockRejectedValueOnce(
      new Error('Remote terminal stream is not connected')
    )

    const pending = await harness.dispatch({
      id: 'rpc_remote_release_transient_close',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_transient_close',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })

    expect(pending).toMatchObject({
      ok: true,
      result: {
        state: 'release_pending',
        lastError: 'Remote terminal stream is not connected',
        recovery: expect.stringContaining('recovery will retry'),
        archive: { source: 'terminal', status: 'captured' }
      }
    })
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'releasing',
      ownership_state: 'owned'
    })

    await expect(
      reconcileRequestedWorkerTerminalReleases(harness.runtime())
    ).resolves.toMatchObject({ attempted: 1, released: 1, unknown: 0 })
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'released',
      ownership_state: 'released'
    })
  })

  it('serves a committed archive when remote release loses its terminal before settlement', async () => {
    const dispatchId = await harness.startSettledRemoteWorker()
    vi.mocked(harness.runtime().closeTerminal).mockImplementation(async () => {
      harness.setWorkerTerminalAvailable(false)
      return {
        ptyKilled: false,
        ptyStopVerdict: 'unverifiable',
        ptyStopReason: 'relay unavailable'
      } as never
    })

    const uncertain = await harness.dispatch({
      id: 'rpc_remote_release_interrupted',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_interrupted',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    expect(uncertain).toMatchObject({
      ok: true,
      result: {
        state: 'release_unknown',
        archive: { source: 'terminal', status: 'captured' },
        recovery: expect.stringContaining('fresh request ID'),
        remoteOutput: {
          archived: true,
          status: { terminal: 'unknown', liveness: 'unverifiable' }
        }
      }
    })

    harness.restartWorkerRuntime(true)
    const archived = await harness.dispatch({
      id: 'rpc_remote_read_interrupted_archive',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId }
    })
    expect(archived).toMatchObject({
      ok: true,
      result: {
        archived: true,
        terminal: { tail: ['remote output'] },
        status: { terminal: 'unknown', liveness: 'unverifiable' }
      }
    })

    const retried = await harness.dispatch({
      id: 'rpc_remote_release_interrupted_retry',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_interrupted_retry',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    expect(retried).toMatchObject({
      ok: true,
      result: {
        state: 'retained',
        reason: 'identity_unproven',
        processAction: 'none',
        archive: { source: 'terminal', status: 'captured' },
        remoteOutput: { archived: true, status: { liveness: 'unverifiable' } }
      }
    })
  })

  it('re-projects archived output when the execution-host close throws', async () => {
    const dispatchId = await harness.startSettledRemoteWorker()
    vi.mocked(harness.runtime().closeTerminal).mockRejectedValue(new Error('close exploded'))

    const release = await harness.dispatch({
      id: 'rpc_remote_release_close_failure',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_close_failure',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })

    expect(release).toMatchObject({
      ok: true,
      result: {
        state: 'release_unknown',
        processAction: 'none',
        archive: { source: 'terminal', status: 'captured' },
        lastError: 'close exploded',
        recovery: expect.stringContaining('fresh request ID'),
        remoteOutput: {
          archived: true,
          status: { terminal: 'unknown', liveness: 'unverifiable' }
        }
      }
    })
  })

  it('preserves a confirmed remote receipt when the home projection fails', async () => {
    const dispatchId = await harness.startSettledRemoteWorker()
    vi.spyOn(harness.homeDb(), 'transitionLifecycle').mockImplementationOnce(() => {
      throw new Error('home projection exploded')
    })

    const release = await harness.dispatch({
      id: 'rpc_remote_release_projection_failure',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_projection_failure',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })

    expect(release).toMatchObject({
      ok: true,
      result: {
        state: 'released',
        processAction: 'closed_agent_terminal',
        archive: { source: 'terminal', status: 'captured' },
        lastError: expect.stringContaining('home projection exploded'),
        recovery: expect.stringContaining('fresh request ID'),
        remoteOutput: {
          terminal: { tail: ['remote output'] },
          status: { terminal: 'exited', liveness: 'exited' }
        }
      }
    })
    expect(JSON.stringify(release)).toContain('execution host acknowledged released')
    expect(JSON.stringify(release)).not.toContain('did not acknowledge release')
    expect(harness.homeDb().getWorkerDispatch(dispatchId)).not.toMatchObject({
      stage: 'released'
    })
    expect(harness.runtime().closeTerminal).toHaveBeenCalledTimes(1)

    const retry = await harness.dispatch({
      id: 'rpc_remote_release_projection_retry',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_projection_retry',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    expect(retry).toMatchObject({
      ok: true,
      result: {
        state: 'already_released',
        processAction: 'none',
        archive: { source: 'terminal', status: 'captured' }
      }
    })
    expect(harness.homeDb().getWorkerDispatch(dispatchId)).toMatchObject({
      stage: 'released',
      agent_terminal_handle: null
    })
    expect(harness.runtime().closeTerminal).toHaveBeenCalledTimes(1)
  })
}
