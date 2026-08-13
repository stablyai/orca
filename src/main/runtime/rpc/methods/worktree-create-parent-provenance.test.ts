import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { WORKTREE_METHODS } from './worktree'

const repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git' as const,
  executionHostId: 'ssh:ssh-target-1' as const
}

const makeRequest = (params: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method: 'worktree.create',
  params
})

describe('worktree create parent provenance', () => {
  it('routes manual parent-workspace provenance to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: <T>(
        _repoSelector: string,
        _clientMutationId: string | undefined,
        run: () => Promise<T>
      ) => run(),
      showRepo: vi.fn().mockResolvedValue(repo),
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest({
        repo: 'repo-1',
        name: 'feature',
        parentWorkspace: 'worktree:repo-1::/parent',
        parentWorkspaceCaptureSource: 'manual-action'
      })
    )

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        lineage: expect.objectContaining({
          parentWorkspace: 'worktree:repo-1::/parent',
          parentWorkspaceCaptureSource: 'manual-action'
        })
      })
    )
  })
})
