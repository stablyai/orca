// The home answers for a worker on a paired server from its own record, and owes a stop the server never got.

import { expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { AutoReleaseScenarioHarness } from './federation-auto-release-scenarios.test-support'

export function registerHomeRecordScenarios(harness: AutoReleaseScenarioHarness): void {
  function fromHome(method: string, params: Record<string, unknown>, requestId: string) {
    return harness.dispatchHome({
      id: `rpc_${requestId}`,
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: requestId,
      method,
      params
    })
  }

  /** The server is off: every call to it gets no answer, or only the ones `methods` names. */
  function serverOff(methods?: string[]) {
    const call = harness.homeRuntime().callOrchestrationWorkerServer.bind(harness.homeRuntime())
    return vi
      .spyOn(harness.homeRuntime(), 'callOrchestrationWorkerServer')
      .mockImplementation((environmentId, method, ...rest) =>
        !methods || methods.includes(method)
          ? Promise.reject(
              new OrchestrationError(
                'remote_runtime_unavailable',
                'Could not connect to the remote Orca runtime.'
              )
            )
          : call(environmentId, method, ...rest)
      )
  }

  it("shows a worker from the home's own record when its server is off", async () => {
    const dispatchId = await harness.startRemoteWorker()
    serverOff()

    await expect(
      fromHome('orchestration.workerShow', { dispatch: dispatchId }, 'show_off')
    ).resolves.toMatchObject({
      ok: true,
      result: {
        worker: { state: 'ready' },
        server: { name: 'windows', reachable: false },
        observation: {
          status: 'unverifiable',
          reason: expect.stringContaining('windows could not be reached')
        },
        projection: {
          host: { kind: 'remote', name: 'windows' },
          liveness: { verdict: 'unverifiable', reason: 'host_unavailable' }
        }
      }
    })
  })

  it('names the server of a remote worker in the worker list, asking nothing of it', async () => {
    const dispatchId = await harness.startRemoteWorker()
    const calls = serverOff()

    const listed = await fromHome('orchestration.workerList', {}, 'list_plain')
    expect(listed).toMatchObject({
      ok: true,
      result: {
        workers: [{ dispatchId, projection: { host: { kind: 'remote', name: 'windows' } } }]
      }
    })
    expect(calls).not.toHaveBeenCalled()
  })

  it('sends a stop the server never got once it answers again', async () => {
    const dispatchId = await harness.startRemoteWorker()
    const off = serverOff(['orchestration.federationStop'])

    await expect(
      fromHome('orchestration.workerStop', { dispatch: dispatchId }, 'stop_off')
    ).resolves.toMatchObject({
      ok: true,
      result: { state: 'stop_unknown', lastError: expect.stringContaining('Orca sends it') }
    })
    expect(harness.homeDb().getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'stop_unknown',
      stage: 'stop_owed'
    })
    expect(harness.workerDb().getRemoteDispatchAttachment(dispatchId)?.state).toBe('ready')

    off.mockRestore()
    await harness.syncHome(dispatchId)

    await vi.waitFor(() =>
      expect(harness.homeDb().getWorkerDispatch(dispatchId)?.state).toBe('stopped')
    )
    expect(harness.workerDb().getRemoteDispatchAttachment(dispatchId)?.state).toBe('stopped')
  })

  it('takes a second worker-stop of a stop whose outcome was unknown', async () => {
    const dispatchId = await harness.startRemoteWorker()
    const call = harness.homeRuntime().callOrchestrationWorkerServer.bind(harness.homeRuntime())
    const unproven = vi
      .spyOn(harness.homeRuntime(), 'callOrchestrationWorkerServer')
      .mockImplementation((environmentId, method, ...rest) =>
        method === 'orchestration.federationStop'
          ? Promise.resolve({ state: 'stopping', alreadySettled: false, processAction: 'unknown' })
          : call(environmentId, method, ...rest)
      )
    await expect(
      fromHome('orchestration.workerStop', { dispatch: dispatchId }, 'stop_unproven')
    ).resolves.toMatchObject({ ok: true, result: { state: 'stop_unknown' } })
    unproven.mockRestore()

    await expect(
      fromHome('orchestration.workerStop', { dispatch: dispatchId }, 'stop_again')
    ).resolves.toMatchObject({ ok: true, result: { state: 'stopped' } })
    expect(harness.workerDb().getRemoteDispatchAttachment(dispatchId)?.state).toBe('stopped')
  })
}
