import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('worktree RPC methods', () => {
  it('routes create options to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'feature',
        baseBranch: 'origin/main',
        setupDecision: 'skip',
        displayName: 'Feature title',
        linkedIssue: 123,
        linkedPR: 456,
        sparseCheckout: { directories: ['src'], presetId: 'preset-1' },
        pushTarget: { remoteName: 'fork', branchName: 'feature' }
      })
    )

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith({
      repoSelector: 'repo-1',
      name: 'feature',
      baseBranch: 'origin/main',
      linkedIssue: 123,
      linkedPR: 456,
      comment: undefined,
      displayName: 'Feature title',
      sparseCheckout: { directories: ['src'], presetId: 'preset-1' },
      pushTarget: { remoteName: 'fork', branchName: 'feature' },
      runHooks: false,
      activate: false,
      setupDecision: 'skip',
      startup: undefined
    })
  })

  it('persists smart sort order on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      persistManagedWorktreeSortOrder: vi.fn().mockReturnValue({ updated: 2 })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.persistSortOrder', { orderedIds: ['wt-1', 'wt-2'] })
    )

    expect(runtime.persistManagedWorktreeSortOrder).toHaveBeenCalledWith(['wt-1', 'wt-2'])
    expect(response).toMatchObject({ ok: true, result: { updated: 2 } })
  })
})
