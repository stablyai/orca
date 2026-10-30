import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../../../shared/runtime-rpc-envelope'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/worker-terminal-auto-release-scheduler'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcRequest } from '../../../core'
import { registerHomeAutoReleaseScenarios } from './federation-home-auto-release-scenarios.test-support'

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

export const GRACE_MS = 2 * 60_000

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

  async function releaseDueOnHost(): Promise<void> {
    vi.setSystemTime(Date.now() + GRACE_MS)
    await getWorkerTerminalAutoReleaseScheduler(harness.workerRuntime()).releaseDue()
  }

  async function listFromHome(dispatchId: string) {
    const listed = await harness.dispatchHome({
      id: 'rpc_remote_list',
      authToken: 'coordinator-token',
      method: 'orchestration.workerList',
      params: { includeRemote: true }
    })
    if (!listed.ok) {
      throw new Error('worker-list failed')
    }
    const result: unknown = listed.result
    const workers =
      typeof result === 'object' &&
      result !== null &&
      'workers' in result &&
      Array.isArray(result.workers)
        ? result.workers
        : []
    return workers.find(
      (worker: unknown) =>
        typeof worker === 'object' &&
        worker !== null &&
        'dispatchId' in worker &&
        worker.dispatchId === dispatchId
    )?.projection
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

  it('arms the host deadline once the home accepts worker_done, then releases there', async () => {
    const dispatchId = await settleRemotely()
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      auto_release_at: '2026-10-27 12:02:00'
    })
    await expect(
      harness.dispatchHome({
        id: 'rpc_remote_show',
        authToken: 'coordinator-token',
        method: 'orchestration.workerShow',
        params: { dispatch: dispatchId }
      })
    ).resolves.toMatchObject({
      result: {
        autoReleaseAt: '2026-10-27T12:02:00Z',
        projection: { autoReleaseAt: '2026-10-27T12:02:00Z', nextAction: { kind: 'none' } }
      }
    })

    await expect(listFromHome(dispatchId)).resolves.toMatchObject({
      autoReleaseAt: '2026-10-27T12:02:00Z',
      nextAction: { kind: 'none' }
    })

    await releaseDueOnHost()

    expect(harness.workerRuntime().closeTerminal).toHaveBeenCalledWith('term_windows_worker')
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe(
      'released'
    )
    // The host released on its own; host observation converges the home without a worker-release.
    expect(harness.homeDb().getWorkerDispatch(dispatchId)?.stage).not.toBe('released')
    await listFromHome(dispatchId)
    expect(harness.homeDb().getWorkerDispatch(dispatchId)).toMatchObject({
      stage: 'released',
      agent_terminal_handle: null
    })
    expect(harness.homeDb().getFederatedDispatch(dispatchId)?.remote_terminal_handle).toBeNull()
  })

  it('converges the home through worker-show after a host-side release', async () => {
    const dispatchId = await settleRemotely()
    await releaseDueOnHost()

    await harness.dispatchHome({
      id: 'rpc_remote_show_after_release',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatchId }
    })

    expect(harness.homeDb().getWorkerDispatch(dispatchId)).toMatchObject({
      stage: 'released',
      agent_terminal_handle: null
    })
  })

  it('joins a home worker-release to the host timer release instead of closing twice', async () => {
    const dispatchId = await settleRemotely()
    let finishClose!: () => void
    vi.mocked(harness.workerRuntime().closeTerminal).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishClose = () =>
            resolve({ handle: 'term_windows_worker', tabId: 'tab-windows-worker', ptyKilled: true })
        })
    )
    vi.setSystemTime(Date.now() + GRACE_MS)
    const timer = getWorkerTerminalAutoReleaseScheduler(harness.workerRuntime()).releaseDue()
    await vi.waitFor(() => expect(harness.workerRuntime().closeTerminal).toHaveBeenCalledTimes(1))

    const explicit = harness.dispatchHome({
      id: 'rpc_remote_release_during_timer',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_during_timer',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    await vi.waitFor(() =>
      expect(harness.remoteCalls()).toContain('orchestration.federationRelease')
    )
    finishClose()

    await expect(explicit).resolves.toMatchObject({ ok: true, result: { state: 'released' } })
    await timer
    expect(harness.workerRuntime().closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('forwards worker-retain to the host so its deadline never fires', async () => {
    const dispatchId = await settleRemotely()

    await expect(retainFromHome(dispatchId)).resolves.toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'user_requested' }
    })
    await releaseDueOnHost()

    expect(harness.remoteCalls()).toContain('orchestration.federationRetain')
    expect(harness.workerRuntime().closeTerminal).not.toHaveBeenCalled()
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'retained',
      auto_release_at: null
    })
  })

  it('holds a host close while its agent works again after worker_done', async () => {
    const dispatchId = await settleRemotely()
    vi.spyOn(harness.workerRuntime(), 'isWorkerAgentInTurn').mockReturnValue(true)

    await releaseDueOnHost()

    expect(harness.workerRuntime().closeTerminal).not.toHaveBeenCalled()
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'owned',
      release_state: 'not_requested',
      auto_release_at: null
    })
  })

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

  it('lets a home worker-release that joins the timer override a working agent on the host', async () => {
    const dispatchId = await settleRemotely()
    const finishCapture = holdHostCapture()
    vi.setSystemTime(Date.now() + GRACE_MS)
    const timer = getWorkerTerminalAutoReleaseScheduler(harness.workerRuntime()).releaseDue()
    await vi.waitFor(() => expect(harness.workerRuntime().readTerminal).toHaveBeenCalled())
    // A follow-up starts after the deadline claimed the close.
    vi.spyOn(harness.workerRuntime(), 'isWorkerAgentInTurn').mockReturnValue(true)

    const explicit = harness.dispatchHome({
      id: 'rpc_remote_release_during_capture',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_during_capture',
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
    await vi.waitFor(() =>
      expect(harness.remoteCalls()).toContain('orchestration.federationRelease')
    )
    finishCapture()

    await expect(explicit).resolves.toMatchObject({ ok: true, result: { state: 'released' } })
    await timer
    expect(harness.workerRuntime().closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('honours an explicit release recorded after the host committed its archive', async () => {
    const dispatchId = await settleRemotely()
    const db = harness.workerDb()
    const commit = db.commitWorkerTerminalArchiveForRelease.bind(db)
    vi.spyOn(db, 'commitWorkerTerminalArchiveForRelease').mockImplementation((params) => {
      vi.spyOn(harness.workerRuntime(), 'isWorkerAgentInTurn').mockReturnValue(true)
      const committed = commit(params)
      // An explicit release joins while the committed archive is being reopened.
      db.requestRemoteAttachmentTerminalRelease(dispatchId)
      return committed
    })

    await releaseDueOnHost()

    expect(harness.workerRuntime().closeTerminal).toHaveBeenCalledTimes(1)
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
  })

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

  it('keeps manual release when the home predates automatic release', async () => {
    harness.setHomeOmitsAutoRelease(true)
    const dispatchId = await settleRemotely()

    await releaseDueOnHost()

    expect(harness.workerDb().getRemoteDispatchAttachment(dispatchId)?.state).toBe('succeeded')
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'not_requested',
      auto_release_at: null
    })
    expect(harness.workerRuntime().closeTerminal).not.toHaveBeenCalled()
  })

  registerHomeAutoReleaseScenarios({ harness, settleRemotely, listFromHome, retainFromHome })

  it('keeps worker-retain home-only for a host that predates automatic release', async () => {
    harness.setWorkerAdvertisesAutoRelease(false)
    const dispatchId = await harness.startRemoteWorker()

    await expect(retainFromHome(dispatchId)).resolves.toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'no_owned_resource' }
    })
    expect(harness.remoteCalls()).not.toContain('orchestration.federationRetain')
  })
}
