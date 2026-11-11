import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../../../shared/runtime-rpc-envelope'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcRequest } from '../../../core'
import { registerHomeAutoReleaseScenarios } from './federation-home-auto-release-scenarios.test-support'
import { GRACE_MS } from './federation-auto-release-grace.test-support'

export type AutoReleaseScenarioHarness = {
  startRemoteWorker: () => Promise<string>
  dispatchHome: (request: RpcRequest) => Promise<RuntimeRpcResponse<unknown>>
  dispatchWorker: (request: RpcRequest) => Promise<RuntimeRpcResponse<unknown>>
  syncHome: (dispatchId: string) => Promise<unknown>
  workerRuntime: () => OrcaRuntimeService
  homeRuntime: () => OrcaRuntimeService
  homeDb: () => OrchestrationDb
  workerDb: () => OrchestrationDb
  remoteCalls: () => string[]
  // Mixed versions: a host without the capability, or a home that never opts in on ack.
  setWorkerAdvertisesAutoRelease: (advertised: boolean) => void
  setHomeOmitsAutoRelease: (omitted: boolean) => void
}

export function registerFederatedAutoReleaseScenarios(harness: AutoReleaseScenarioHarness): void {
  afterEach(() => {
    getWorkerTerminalAutoReleaseScheduler(harness.workerRuntime()).clear()
    getWorkerTerminalAutoReleaseScheduler(harness.homeRuntime()).clear()
    vi.useRealTimers()
  })

  async function settleRemotely(): Promise<string> {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    const dispatchId = await harness.startRemoteWorker()
    const taskId = harness.homeDb().getDispatchContextById(dispatchId)!.task_id
    const sent = harness.dispatchWorker({
      id: 'rpc_remote_worker_done',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_worker_done',
      method: 'orchestration.send',
      params: {
        from: 'term_windows_worker',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
      }
    })
    await vi.waitFor(() =>
      expect(harness.workerDb().listPendingFederationRelay(dispatchId, 'to_home')).toHaveLength(1)
    )
    // Queued, not yet accepted by the home: no deadline.
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at).toBe(
      null
    )
    await harness.syncHome(dispatchId)
    await expect(sent).resolves.toMatchObject({ ok: true })
    return dispatchId
  }

  function retainFromHome(dispatchId: string) {
    return harness.dispatchHome({
      id: 'rpc_remote_retain',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_retain',
      method: 'orchestration.workerRetain',
      params: { dispatch: dispatchId }
    })
  }

  function holdHostCapture() {
    const read = {
      handle: 'term_windows_worker',
      status: 'running' as const,
      tail: ['remote output'],
      truncated: false,
      nextCursor: '1'
    }
    const held: (() => void)[] = []
    vi.mocked(harness.workerRuntime().readTerminal).mockImplementation(
      () => new Promise((resolve) => held.push(() => resolve(read)))
    )
    return () => {
      vi.mocked(harness.workerRuntime().readTerminal).mockResolvedValue(read)
      held.splice(0).forEach((release) => release())
    }
  }

  it('publishes no archive when worker-retain wins during host capture', async () => {
    const dispatchId = await settleRemotely()
    const finishCapture = holdHostCapture()
    vi.setSystemTime(Date.now() + GRACE_MS)
    const timer = getWorkerTerminalAutoReleaseScheduler(harness.workerRuntime()).releaseDue()
    await vi.waitFor(() => expect(harness.workerRuntime().readTerminal).toHaveBeenCalled())

    await expect(retainFromHome(dispatchId)).resolves.toMatchObject({ ok: true })
    finishCapture()
    await timer

    expect(harness.workerRuntime().closeTerminal).not.toHaveBeenCalled()
    expect(harness.workerDb().getWorkerTerminalArchive(dispatchId)).toBeUndefined()
  })

  registerHomeAutoReleaseScenarios({ harness, settleRemotely })
}
