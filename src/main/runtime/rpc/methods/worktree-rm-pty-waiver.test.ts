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

/** The dispatcher validates against the Zod schema, so the test spells the wire shape. */
type RmParams = {
  hostId?: string
  force?: boolean
  runHooks?: boolean
  allowUnverifiedPtyStop?: boolean
  allowFailedArchiveHook?: boolean
}

async function dispatchRm(runtime: OrcaRuntimeService, params: RmParams): Promise<void> {
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
  const request: RpcRequest = {
    id: 'req-1',
    authToken: 'tok',
    method: 'worktree.rm',
    params: { worktree: 'id:wt-1', ...params }
  }
  await dispatcher.dispatch(request)
}

/** Every waiver off unless a case turns it on — the defaults are the assertion. */
const forwarded = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  force: false,
  runHooks: false,
  allowUnverifiedPtyStop: false,
  allowFailedArchiveHook: false,
  hostId: 'local',
  ...overrides
})

// Why (#11960 and #19334): each waiver rides its own field. The desktop sets `force` for an
// ordinary confirmed delete, so keying either waiver off `force` would silently disable that gate
// on the primary delete path. These cases exist to keep `force` from acquiring a second meaning.
describe('worktree.rm waivers travel on their own fields', () => {
  it.each([
    [
      'an explicit PTY-stop waiver reaches the runtime',
      { hostId: 'local', force: true, allowUnverifiedPtyStop: true, runHooks: false },
      forwarded({ force: true, allowUnverifiedPtyStop: true })
    ],
    [
      'force alone does NOT waive the PTY-stop proof',
      { hostId: 'local', force: true, runHooks: false },
      forwarded({ force: true })
    ],
    [
      'an explicit archive-hook waiver reaches the runtime',
      { hostId: 'local', runHooks: true, allowFailedArchiveHook: true },
      forwarded({ runHooks: true, allowFailedArchiveHook: true })
    ],
    [
      'force plus a PTY waiver does NOT waive a failed archive hook',
      { hostId: 'local', force: true, allowUnverifiedPtyStop: true, runHooks: true },
      forwarded({ force: true, runHooks: true, allowUnverifiedPtyStop: true })
    ]
  ])('%s', async (_name, params, expected) => {
    const runtime = makeRuntime()
    await dispatchRm(runtime, params)
    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith('id:wt-1', expected)
  })

  it('resolves the host before forwarding an unqualified removal', async () => {
    const runtime = makeRuntime()
    await dispatchRm(runtime, { force: true, runHooks: false })

    expect(runtime.showManagedWorktree).toHaveBeenCalledWith('id:wt-1')
    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      forwarded({ force: true, hostId: 'ssh:builder' })
    )
  })
})
