import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { WORKTREE_METHODS } from './worktree'

describe('worktree GitHub PR suppression RPC', () => {
  it('forwards suppression writes to host-owned metadata persistence', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateManagedWorktreeMeta: vi.fn().mockResolvedValue({ id: 'wt-1' })
    } as unknown as OrcaRuntimeService
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.set',
      params: {
        worktree: 'id:wt-1',
        linkedPR: null,
        suppressedGitHubPR: 42
      }
    }

    const response = await new RpcDispatcher({ runtime, methods: WORKTREE_METHODS }).dispatch(
      request
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ linkedPR: null, suppressedGitHubPR: 42 })
    )
  })
})
