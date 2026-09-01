import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('worktree.pendingAgentLaunchSummary RPC', () => {
  it('dispatches with no params and returns the redacted summary', async () => {
    const pendingAgentLaunchSummary = vi.fn().mockReturnValue({
      rows: [
        {
          sourceKind: 'cli',
          baseHarness: 'codex',
          targetHostDisplayName: 'x',
          admittedAt: 1,
          liveness: 'live'
        }
      ]
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      pendingAgentLaunchSummary
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.pendingAgentLaunchSummary', {})
    )

    expect(response).toMatchObject({ ok: true, result: { rows: [{ liveness: 'live' }] } })
    // clientKind and pairedDeviceId are both undefined for an in-process/local
    // dispatch; together they scope the admission principal, never client JSON.
    expect(pendingAgentLaunchSummary).toHaveBeenCalledWith(undefined, undefined)
  })
})
