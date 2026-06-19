import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { DIAGNOSTICS_METHODS } from './diagnostics'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('diagnostics RPC methods', () => {
  it('collects the runtime memory snapshot', async () => {
    const snapshot = {
      app: {
        cpu: 1,
        memory: 1024,
        main: { cpu: 1, memory: 512 },
        renderer: { cpu: 0, memory: 256 },
        other: { cpu: 0, memory: 256 },
        history: [1024]
      },
      worktrees: [],
      host: {
        totalMemory: 4096,
        freeMemory: 1024,
        usedMemory: 3072,
        memoryUsagePercent: 75,
        cpuCoreCount: 8,
        loadAverage1m: 1.25
      },
      totalCpu: 1,
      totalMemory: 1024,
      collectedAt: 123
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getMemorySnapshot: vi.fn().mockResolvedValue(snapshot)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: DIAGNOSTICS_METHODS })

    const response = await dispatcher.dispatch(makeRequest('diagnostics.memory'))

    expect(runtime.getMemorySnapshot).toHaveBeenCalledTimes(1)
    expect(response).toMatchObject({
      ok: true,
      result: snapshot
    })
  })
})
