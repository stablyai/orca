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
    showManagedWorktree: vi.fn().mockResolvedValue({ hostId: 'ssh:builder' }),
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
      params: {
        worktree: 'id:wt-1',
        hostId: 'local',
        force: true,
        allowUnverifiedPtyStop: true,
        runHooks: false
      }
    } satisfies RpcRequest)

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      true,
      false,
      true,
      'local',
      false
    )
  })

  it('does not infer a waiver from force alone', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.rm',
      params: { worktree: 'id:wt-1', hostId: 'local', force: true, runHooks: false }
    } satisfies RpcRequest)

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      true,
      false,
      false,
      'local',
      false
    )
  })

  it('resolves the host before forwarding an unqualified removal', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.rm',
      params: { worktree: 'id:wt-1', force: true, runHooks: false }
    } satisfies RpcRequest)

    expect(runtime.showManagedWorktree).toHaveBeenCalledWith('id:wt-1')
    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      true,
      false,
      false,
      'ssh:builder',
      false
    )
  })
})

// Why (#19334): same shape, same reason — a FAILED archive hook blocks removal, and waiving that
// is its own explicit decision. `force` must not carry it either.
describe('worktree.rm archive-hook waiver', () => {
  it('forwards an explicit archive-hook waiver to the runtime', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.rm',
      params: {
        worktree: 'id:wt-1',
        hostId: 'local',
        runHooks: true,
        allowFailedArchiveHook: true
      }
    } satisfies RpcRequest)

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      false,
      true,
      false,
      'local',
      true
    )
  })

  it('does not infer an archive-hook waiver from force', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.rm',
      params: {
        worktree: 'id:wt-1',
        hostId: 'local',
        force: true,
        allowUnverifiedPtyStop: true,
        runHooks: true
      }
    } satisfies RpcRequest)

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      true,
      true,
      true,
      'local',
      false
    )
  })
})
