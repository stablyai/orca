import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { WORKTREE_METHODS } from './worktree'

describe('worktree missing-terminal teardown RPC', () => {
  it('routes the connection-scoped request through the runtime owner', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      teardownMissingManagedWorktreeTerminals: vi
        .fn()
        .mockResolvedValue({ stoppedWorktreeIds: ['repo-1::/workspace/deleted'] })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch({
      id: 'request-1',
      authToken: 'token',
      method: 'worktree.teardownMissingTerminals',
      params: {
        repo: 'repo-1',
        worktreeIds: ['repo-1::/workspace/deleted'],
        connectionId: 'ssh-1'
      }
    })

    expect(runtime.teardownMissingManagedWorktreeTerminals).toHaveBeenCalledWith(
      'repo-1',
      ['repo-1::/workspace/deleted'],
      'ssh-1'
    )
    expect(response).toMatchObject({ ok: true })
  })
})
