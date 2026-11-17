import { expect, it, vi } from 'vitest'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'

import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { AutoReleaseScenarioHarness } from './federation-auto-release-scenarios.test-support'
import { GRACE_MS } from './federation-auto-release-grace.test-support'

export function registerHomeAutoReleaseScenarios(args: {
  harness: AutoReleaseScenarioHarness
  settleRemotely: () => Promise<string>
}): void {
  const { harness } = args

  async function settleOnOlderHost(): Promise<string> {
    harness.setWorkerAdvertisesAutoRelease(false)
    harness.setHomeOmitsAutoRelease(true)
    return args.settleRemotely()
  }

  async function releaseDueAtHome(): Promise<void> {
    vi.setSystemTime(Date.now() + GRACE_MS)
    await getWorkerTerminalAutoReleaseScheduler(harness.homeRuntime()).releaseDue()
  }

  it('leaves a worker the user kept open on the host when the home deadline fires', async () => {
    const dispatchId = await settleOnOlderHost()
    const paneKey = harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)!.pane_key!
    expect(harness.workerDb().keepWorkerTerminalOpen(paneKey)).toBe(1)

    await releaseDueAtHome()

    expect(harness.workerRuntime().closeTerminal).not.toHaveBeenCalled()
    expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'retained',
      retained_reason: 'user_kept'
    })
    expect(harness.homeDb().getFederatedDispatch(dispatchId)?.home_auto_release_state).toBe('ended')
  })

  function stopFromHome(dispatchId: string) {
    return harness.dispatchHome({
      id: 'rpc_remote_stop',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_stop',
      method: 'orchestration.workerStop',
      params: { dispatch: dispatchId }
    })
  }

  it('refuses a home worker-stop of a worker kept open on its host before either side stops it', async () => {
    const dispatchId = await harness.startRemoteWorker()
    const paneKey = harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)?.pane_key
    expect(harness.workerDb().keepWorkerTerminalOpen(paneKey ?? '')).toBe(1)

    await expect(stopFromHome(dispatchId)).resolves.toMatchObject({
      ok: false,
      error: { code: 'terminal_kept_open' }
    })
    expect(harness.homeDb().getWorkerDispatch(dispatchId)?.state).toBe('ready')
    expect(harness.remoteCalls()).not.toContain('orchestration.federationStop')
    // An older home skips that check; the host still refuses before it stops anything.
    expect(() => harness.workerDb().beginRemoteAttachmentStop(dispatchId)).toThrow('Keep open')
    expect(harness.workerDb().getRemoteDispatchAttachment(dispatchId)?.state).toBe('ready')
  })

  it('stops nothing when the home cannot ask the host whether the worker is kept open', async () => {
    const dispatchId = await harness.startRemoteWorker()
    const call = harness.homeRuntime().callOrchestrationWorkerServer.bind(harness.homeRuntime())
    vi.spyOn(harness.homeRuntime(), 'callOrchestrationWorkerServer').mockImplementation(
      (environmentId, method, ...rest) =>
        method === 'orchestration.federationShow'
          ? Promise.reject(new Error('timed out'))
          : call(environmentId, method, ...rest)
    )

    await expect(stopFromHome(dispatchId)).resolves.toMatchObject({
      ok: false,
      error: { code: 'remote_runtime_unavailable' }
    })
    expect(harness.homeDb().getWorkerDispatch(dispatchId)?.state).toBe('ready')
    expect(harness.homeDb().getDispatchContextById(dispatchId)?.capability_revoked_at).toBeNull()
  })
}
