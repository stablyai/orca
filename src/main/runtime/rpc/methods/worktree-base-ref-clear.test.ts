import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { WORKTREE_METHODS } from './worktree'

describe('worktree base ref clear RPC', () => {
  it('forwards null as a clear and strings as a set', async () => {
    const updateManagedWorktreeMeta = vi.fn().mockResolvedValue({ id: 'wt-1' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktree.set reads only these runtime members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateManagedWorktreeMeta
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    const set = (params: Record<string, unknown>) =>
      dispatcher.dispatch({ id: 'req', authToken: 'tok', method: 'worktree.set', params })

    expect(await set({ worktree: 'id:wt-1', baseRef: null })).toMatchObject({ ok: true })
    expect(await set({ worktree: 'id:wt-1', baseRef: 'origin/main' })).toMatchObject({ ok: true })

    expect(updateManagedWorktreeMeta).toHaveBeenNthCalledWith(
      1,
      'id:wt-1',
      expect.objectContaining({ baseRef: null })
    )
    expect(updateManagedWorktreeMeta).toHaveBeenNthCalledWith(
      2,
      'id:wt-1',
      expect.objectContaining({ baseRef: 'origin/main' })
    )
  })
})
