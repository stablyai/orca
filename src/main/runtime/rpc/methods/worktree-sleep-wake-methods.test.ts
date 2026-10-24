import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('worktree.wake', () => {
  it('wakes slept agents for a local CLI caller, which has no mobile clientKind', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktree.wake reads only the runtime members stubbed here.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      wakeManagedWorktree: vi
        .fn()
        .mockResolvedValue({ worktreeId: 'wt-1', sleepingAgentWake: 'requested' }),
      activateManagedWorktree: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.wake', { worktree: 'id:wt-1' })
    )

    expect(response).toMatchObject({
      ok: true,
      result: { worktreeId: 'wt-1', sleepingAgentWake: 'requested' }
    })
    expect(runtime.wakeManagedWorktree).toHaveBeenCalledWith('id:wt-1')
    expect(runtime.activateManagedWorktree).not.toHaveBeenCalled()
  })

  it('rejects a call without a worktree selector', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktree.wake reads only the runtime members stubbed here.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      wakeManagedWorktree: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(makeRequest('worktree.wake', {}))

    expect(response).toMatchObject({ ok: false })
    expect(runtime.wakeManagedWorktree).not.toHaveBeenCalled()
  })
})
