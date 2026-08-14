import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

function makeRuntime(): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    dedupeWorktreeCreate: <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
      run(),
    removeManagedWorktree: vi.fn().mockResolvedValue({})
  } as unknown as OrcaRuntimeService
}

// Why (#11960): waiving the proof that every PTY stopped must ride its own field.
// The desktop sets `force` for an ordinary confirmed delete, so keying the waiver
// off `force` would silently disable the gate on the primary delete path.
describe('worktree.rm PTY-stop waiver', () => {
  it('forwards an explicit waiver to the runtime', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.rm',
      params: { worktree: 'id:wt-1', force: true, allowUnverifiedPtyStop: true, runHooks: false }
    } satisfies RpcRequest)

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith('id:wt-1', true, false, true)
  })

  it('does not infer a waiver from force alone', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.rm',
      params: { worktree: 'id:wt-1', force: true, runHooks: false }
    } satisfies RpcRequest)

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith('id:wt-1', true, false, false)
  })
})
