import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

function dispatcherWith(persistManagedWorktreeSortOrder: ReturnType<typeof vi.fn>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only these two members for this method.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    persistManagedWorktreeSortOrder
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
}

function persistSortOrder(params: unknown) {
  return { id: 'req-1', authToken: 'tok', method: 'worktree.persistSortOrder', params }
}

describe('worktree.persistSortOrder', () => {
  it('persists smart sort order on the runtime server', async () => {
    const persist = vi.fn().mockReturnValue({ updated: 2 })

    const response = await dispatcherWith(persist).dispatch(
      persistSortOrder({ orderedIds: ['wt-1', 'wt-2'] })
    )

    expect(persist).toHaveBeenCalledWith(['wt-1', 'wt-2'], undefined)
    expect(response).toMatchObject({ ok: true, result: { updated: 2 } })
  })

  it("forwards each id's host so a same-id twin keeps its own order", async () => {
    const persist = vi.fn().mockReturnValue({ updated: 1 })

    await dispatcherWith(persist).dispatch(
      persistSortOrder({ orderedIds: ['wt-1'], hostIds: ['ssh:box'] })
    )

    expect(persist).toHaveBeenCalledWith(['wt-1'], ['ssh:box'])
  })
})
