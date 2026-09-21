import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { WORKTREE_METHODS } from './worktree'

function makeRuntime(repoHostIds: (string | undefined)[] = ['local']): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    listRepos: () =>
      repoHostIds.map((executionHostId) => ({ id: 'repo-1', path: '/repo', executionHostId })),
    showManagedWorktree: vi.fn().mockResolvedValue({ id: 'wt-1', hostId: 'local' }),
    removeManagedWorktree: vi.fn().mockResolvedValue({})
  } as unknown as OrcaRuntimeService
}

const WORKTREE_ID = 'repo-1::/repo/wt'

function makeRequest(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'worktree.rm', params }
}

describe('worktree.rm host qualification', () => {
  it('routes an explicitly qualified removal to that host', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-1', hostId: 'local', force: true, runHooks: false })
    )

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      true,
      false,
      false,
      'local'
    )
    expect(response).toMatchObject({ ok: true, result: { removed: true } })
  })

  it("resolves a paired client's own name for this host to our spelling", async () => {
    const runtime = makeRuntime(['local'])
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        worktree: `id:${WORKTREE_ID}`,
        hostId: 'runtime:env-1',
        force: true,
        runHooks: false
      })
    )

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      `id:${WORKTREE_ID}`,
      true,
      false,
      false,
      'local'
    )
    expect(response).toMatchObject({ ok: true, result: { removed: true } })
  })

  it('keeps a client-minted stamp this store still uses for its own repo', async () => {
    const runtime = makeRuntime(['runtime:env-1'])
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest({
        worktree: `id:${WORKTREE_ID}`,
        hostId: 'runtime:env-1',
        force: true,
        runHooks: false
      })
    )

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      `id:${WORKTREE_ID}`,
      true,
      false,
      false,
      'runtime:env-1'
    )
  })

  it('fails closed when the repo id carries both spellings', async () => {
    const runtime = makeRuntime(['local', 'runtime:env-1'])
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        worktree: `id:${WORKTREE_ID}`,
        hostId: 'runtime:env-1',
        force: true,
        runHooks: false
      })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('ambiguous across hosts') }
    })
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('leaves an ssh qualifier alone, since we do proxy those onward', async () => {
    const runtime = makeRuntime(['ssh:target-a'])
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest({
        worktree: `id:${WORKTREE_ID}`,
        hostId: 'ssh:target-a',
        force: true,
        runHooks: false
      })
    )

    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      `id:${WORKTREE_ID}`,
      true,
      false,
      false,
      'ssh:target-a'
    )
  })

  it.each([['bogus'], ['ssh:'], ['runtime:'], [''], [null], [42]])(
    'fails closed when an explicit host id is malformed: %j',
    async (hostId) => {
      const runtime = makeRuntime()
      const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

      const response = await dispatcher.dispatch(
        makeRequest({ worktree: 'id:wt-1', hostId, force: true, runHooks: false })
      )

      expect(response).toMatchObject({ ok: false })
      expect(runtime.showManagedWorktree).not.toHaveBeenCalled()
      expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
    }
  )

  it('resolves an old-client removal through the ambiguity-aware worktree lookup', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-1', force: true, runHooks: false })
    )

    expect(runtime.showManagedWorktree).toHaveBeenCalledWith('id:wt-1')
    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-1',
      true,
      false,
      false,
      'local'
    )
    expect(response).toMatchObject({ ok: true, result: { removed: true } })
  })

  it('fails closed when an old-client selector is ambiguous', async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.showManagedWorktree).mockRejectedValue(new Error('selector_ambiguous'))
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-1', force: true, runHooks: false })
    )

    expect(response).toMatchObject({ ok: false, error: { message: 'selector_ambiguous' } })
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('fails closed when an old-client row has no host evidence', async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.showManagedWorktree).mockResolvedValue({ id: 'wt-1' } as never)
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-1', force: true, runHooks: false })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { message: 'worktree.rm could not resolve the workspace host' }
    })
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })
  // Why: a delete legitimately arrives after Git stops listing the path (the
  // caller is clearing a stale row). Pre-resolving the host must not turn that
  // into a hard failure for a client that sends no hostId — mobile could delete
  // such a row before host qualification and must still be able to.
  it('still deletes a stale workspace for an old client once Git no longer lists it', async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.showManagedWorktree).mockRejectedValue(new Error('selector_not_found'))
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-gone', force: true, runHooks: false })
    )

    expect(response).toMatchObject({ ok: true, result: { removed: true } })
    // Unqualified on purpose: removeManagedWorktree owns the stale-row path and
    // still refuses on its own if the id turns out to have two owners.
    expect(runtime.removeManagedWorktree).toHaveBeenCalledWith(
      'id:wt-gone',
      true,
      false,
      false,
      undefined
    )
  })

  it('propagates a non-missing lookup failure instead of deleting unqualified', async () => {
    const runtime = makeRuntime()
    vi.mocked(runtime.showManagedWorktree).mockRejectedValue(new Error('selector_ambiguous'))
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({ worktree: 'id:wt-1', force: true, runHooks: false })
    )

    expect(response).toMatchObject({ ok: false, error: { message: 'selector_ambiguous' } })
    expect(runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })
})
