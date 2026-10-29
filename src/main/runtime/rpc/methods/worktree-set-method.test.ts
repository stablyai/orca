import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

describe('worktree.set', () => {
  it('forwards the review-note base through worktree.set', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateManagedWorktreeMeta: vi.fn().mockResolvedValue({ id: 'wt-1' })
    }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktree.set reads only these two runtime members.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: WORKTREE_METHODS
    })
    const comment = {
      id: 'n1',
      worktreeId: 'wt-1',
      filePath: 'a.ts',
      lineNumber: 1,
      body: 'b',
      createdAt: 1,
      side: 'modified'
    }

    await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.set',
      params: { worktree: 'id:wt-1', diffComments: [comment], diffCommentsBase: [] }
    })

    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ diffComments: [comment], diffCommentsBase: [] })
    )
  })
})
