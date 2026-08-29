import { describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_WORKER_STOP_METHODS } from './orchestration-worker-stop'

describe('federated worker stop capability', () => {
  it('does not trust a legacy server stop receipt', async () => {
    const markWorkerStopUnknown = vi.fn((_dispatchId: string, reason: string) => ({
      state: 'stop_unknown',
      last_error: reason
    }))
    const db = {
      getFederatedDispatch: vi.fn(() => ({
        dispatch_id: 'ctx_remote',
        environment_id: 'environment_linux',
        environment_name: 'linux',
        peer_fingerprint: 'peer-linux'
      })),
      beginWorkerStop: vi.fn(() => ({ disposition: 'started' })),
      markWorkerStopUnknown
    } as unknown as OrchestrationDb
    const callOrchestrationWorkerServer = vi.fn(async (_environmentId, method) => {
      if (method === 'status.get') {
        return { capabilities: [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY] }
      }
      return { state: 'stopped', processAction: 'closed_agent_terminal' }
    })
    const runtime = {
      getOrchestrationDb: () => db,
      getRuntimeId: () => 'runtime_current',
      resolveOrchestrationWorkerServer: () => ({
        environmentId: 'environment_linux',
        name: 'linux',
        peerFingerprint: 'peer-linux'
      }),
      callOrchestrationWorkerServer
    } as unknown as OrcaRuntimeService
    const method = ORCHESTRATION_WORKER_STOP_METHODS[0]!

    await expect(
      method.handler(method.params!.parse({ dispatch: 'ctx_remote' }), {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'coordinator',
          requestId: 'request_stop',
          method: 'orchestration.workerStop',
          payloadHash: 'hash'
        }
      })
    ).resolves.toMatchObject({ state: 'stop_unknown', processAction: 'none' })
    expect(db.beginWorkerStop).toHaveBeenCalledWith('ctx_remote', 'runtime_current')
    expect(markWorkerStopUnknown).toHaveBeenCalledWith(
      'ctx_remote',
      'Connected server linux cannot prove the worker stop outcome.'
    )
    expect(callOrchestrationWorkerServer).toHaveBeenCalledTimes(1)
  })
})
