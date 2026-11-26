import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, type RpcContext } from '../../../rpc/core'
import {
  ORCHESTRATION_WORKER_START_METHODS,
  startWorker
} from '../../../rpc/methods/orchestration/worker/worker-start-method'
import { WorkerStartParams } from '../../../../../shared/rpc-contract/orchestration/orchestration-worker-start-params'
import { routeRemoteOwnedCall } from './remote-owned-route'

describe('worker-start --item --on', () => {
  let db: OrchestrationDb
  const resolveServer = vi.fn()
  const callServer = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this path reads only the stubbed members.
  const runtime = {
    getOrchestrationDb: () => db,
    resolveOrchestrationWorkerServer: resolveServer,
    callOrchestrationWorkerServer: callServer
  } as unknown as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a local CLI caller; the route and the refusal read only runtime and caller.
  const ctx = { runtime } as unknown as RpcContext
  const params = { from: 'term_bot', spec: 'work', on: 'Windows', origin: 'bot-item:1' }

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    resolveServer.mockReset()
    callServer.mockReset()
  })
  afterEach(() => db.close())

  it('stays local without asking the paired server', async () => {
    const routed = await routeRemoteOwnedCall(
      runtime,
      eraseRpcMethods(ORCHESTRATION_WORKER_START_METHODS)[0]!,
      { id: 'r1', authToken: '', method: 'orchestration.workerStart', params },
      params,
      ctx
    )

    expect(routed).toEqual({ handled: false })
    expect(resolveServer).not.toHaveBeenCalled()
    expect(callServer).not.toHaveBeenCalled()
  })

  it('is refused by the ordinary start', async () => {
    await expect(startWorker(WorkerStartParams.parse(params), ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining("--item can't be combined with --on")
    })
  })
})
