import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { REPO_METHODS } from './repo'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('repo badge color RPC updates', () => {
  it('normalizes repo badge colors before runtime updates', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateRepo: vi.fn().mockResolvedValue({
        id: 'repo-1',
        path: '/srv/repo',
        badgeColor: '#abcdef'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('repo.update', {
        repo: 'repo-1',
        updates: { badgeColor: ' ABCDEF ' }
      })
    )

    expect(runtime.updateRepo).toHaveBeenCalledWith('repo-1', {
      badgeColor: '#abcdef'
    })
    expect(response).toMatchObject({
      ok: true,
      result: { repo: { id: 'repo-1', badgeColor: '#abcdef' } }
    })
  })
})
