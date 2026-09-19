import { describe, expect, it } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeServeStatsResult } from '../../../../shared/runtime-types'

function makeRequest(method: string): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method }
}

describe('serve.stats RPC method', () => {
  it('is registered in the real RPC registry and dispatches to runtime.getServeStats', async () => {
    const stats: RuntimeServeStatsResult = {
      version: '9.9.9-test',
      runtimeId: 'test-runtime',
      uptimeSeconds: 42,
      port: 6970,
      counts: {
        agents: 1,
        tasks: 2,
        terminals: 3,
        terminalsUnverifiable: 1,
        terminalsExited: 6,
        worktrees: 4,
        browserPages: 5,
        browserPagesRetained: 2,
        // #14552's shape: one 1.3 GB renderer inside a 2.1 GB total.
        browserPageMemoryTotalBytes: 2_100_000_000,
        browserPageMemoryMaxBytes: 1_300_000_000,
        tasksByStatus: {
          pending: 1,
          ready: 0,
          dispatched: 1,
          completed: 3,
          failed: 2,
          blocked: 0
        },
        agentsByState: { working: 1, permission: 0, idle: 0, unknown: 0 },
        workersByTerminalState: {
          active: 1,
          reclaimable: 4,
          retained: 2,
          release_pending: 0,
          release_unknown: 3,
          released: 5
        }
      },
      host: {
        loadAverage1m: 6.85,
        cpuCoreCount: 4,
        memoryTotalBytes: 8 * 1024 ** 3,
        memoryAvailableBytes: 1024 ** 3,
        memoryAvailableSource: 'proc-meminfo',
        swapUsedBytes: 2_500_000_000,
        // #18789: pids.current pinned just under a 4096 ceiling.
        pids: { current: 4090, max: 4096 }
      },
      health: {
        eventLoopDelayP99Ms: 15_200.5,
        // #19342: the ask sub-pool full while the total pool still had room.
        longPolls: {
          total: { active: 8, cap: 16 },
          ask: { active: 8, cap: 8 },
          browserHost: { active: 0, cap: 8 },
          specialized: { active: 8, cap: 12 }
        }
      }
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getServeStats: async () => stats
    } as unknown as OrcaRuntimeService

    // Why: no `methods` override — this dispatcher uses the default
    // ALL_RPC_METHODS registry (rpc/methods/index.ts), so a missing
    // `...SERVE_STATS_METHODS` spread there, or a method-name typo, fails
    // this test rather than only a scoped one.
    const dispatcher = new RpcDispatcher({ runtime })

    const response = await dispatcher.dispatch(makeRequest('serve.stats'))

    expect(response).toMatchObject({ ok: true, result: stats })
  })
})
