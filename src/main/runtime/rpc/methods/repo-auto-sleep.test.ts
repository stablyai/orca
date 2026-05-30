import { describe, expect, it, vi } from 'vitest'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { REPO_METHODS } from './repo'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('repo auto-sleep RPC methods', () => {
  it('accepts auto-sleep updates across the runtime boundary', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateRepo: vi.fn().mockResolvedValue({
        id: 'repo-1',
        path: '/srv/repo',
        autoSleepInactiveWorkspacesAfterMs: null
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('repo.update', {
        repo: 'repo-1',
        updates: { autoSleepInactiveWorkspacesAfterMs: null }
      })
    )

    expect(runtime.updateRepo).toHaveBeenCalledWith('repo-1', {
      autoSleepInactiveWorkspacesAfterMs: null
    })
    expect(response).toMatchObject({
      ok: true,
      result: { repo: { id: 'repo-1', autoSleepInactiveWorkspacesAfterMs: null } }
    })
  })
})
