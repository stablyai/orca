import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { WORKTREE_METHODS } from './worktree'
import { WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

function makeRuntime() {
  return {
    getRuntimeId: () => 'test-runtime',
    getWorktreePs: vi.fn().mockResolvedValue({
      worktrees: [],
      totalCount: 0,
      truncated: false
    })
  } as unknown as OrcaRuntimeService
}

describe('worktree.ps catalog snapshots', () => {
  afterEach(() => vi.restoreAllMocks())

  it('preserves legacy fields and adds a clock sample without requiring a snapshot request', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    const response = await dispatcher.dispatch({
      id: 'legacy',
      authToken: 'token',
      method: 'worktree.ps',
      params: { limit: 10_000 }
    })

    expect(response).toMatchObject({
      ok: true,
      result: { worktrees: [], totalCount: 0, truncated: false, observedAt: expect.any(Number) }
    })
    expect((response as { result: unknown }).result).not.toHaveProperty('snapshotId')
  })

  it('returns a full snapshot followed by a tiny unchanged response', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    const first = await dispatcher.dispatch({
      id: 'first',
      authToken: 'token',
      method: 'worktree.ps',
      params: { limit: 10_000, afterSnapshotId: null }
    })
    const snapshotId = (first as { result: { snapshotId: string } }).result.snapshotId
    expect(first).toMatchObject({ result: { observedAt: 1_000 } })
    clock.mockReturnValue(9_000)

    const second = await dispatcher.dispatch({
      id: 'second',
      authToken: 'token',
      method: 'worktree.ps',
      params: { limit: 10_000, afterSnapshotId: snapshotId }
    })

    expect(snapshotId).toEqual(expect.any(String))
    expect(second).toMatchObject({
      ok: true,
      result: { unchanged: true, snapshotId, observedAt: 9_000 }
    })
    expect(runtime.getWorktreePs).toHaveBeenCalledTimes(2)
  })

  it('gates source-default worktree projection by client capability', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    await dispatcher.dispatchStreaming(
      {
        id: 'legacy',
        authToken: 'token',
        method: 'worktree.ps',
        params: { limit: 10_000 }
      },
      () => {},
      { clientCapabilities: [] }
    )
    await dispatcher.dispatchStreaming(
      {
        id: 'current',
        authToken: 'token',
        method: 'worktree.ps',
        params: { limit: 10_000 }
      },
      () => {},
      { clientCapabilities: [WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY] }
    )
    await dispatcher.dispatchStreaming(
      {
        id: 'mobile',
        authToken: 'token',
        method: 'worktree.ps',
        params: { limit: 10_000, supportsWorktreeVisibilitySourceDefaults: true }
      },
      () => {},
      { clientCapabilities: [] }
    )

    expect(runtime.getWorktreePs).toHaveBeenNthCalledWith(1, 10_000, false)
    expect(runtime.getWorktreePs).toHaveBeenNthCalledWith(2, 10_000, true)
    expect(runtime.getWorktreePs).toHaveBeenNthCalledWith(3, 10_000, true)
  })
})
