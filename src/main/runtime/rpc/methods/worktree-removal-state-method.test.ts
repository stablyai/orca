import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { OrcaRuntimeService } from '../../orca-runtime'
import { classifyRuntimeLongPoll } from '../../runtime-rpc/runtime-rpc-long-poll'
import { WORKTREE_METHODS } from './worktree'

const ID = 'repo-1::/nonexistent/orca-rm-wait/wt-1'

describe('worktree.removalState', () => {
  it('answers from the runtime for the id and host the caller resolved', async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'readWorktreeRemovalState').mockResolvedValue({ state: 'removing' })
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.removalState',
      params: { worktreeId: ID, hostId: 'local' }
    })

    expect(response).toMatchObject({ ok: true, result: { state: 'removing' } })
    expect(runtime.readWorktreeRemovalState).toHaveBeenCalledWith(ID, 'local')
  })

  // Why: a caller waiting out a long delete must not hold a slot other clients' waits need.
  it('neither the delete nor its read is a long poll', () => {
    for (const method of ['worktree.rm', 'worktree.removalState']) {
      expect(
        classifyRuntimeLongPoll({
          id: 'req-1',
          authToken: 'tok',
          method,
          params: { worktree: `id:${ID}`, worktreeId: ID }
        })
      ).toBeNull()
    }
  })

  it("reads only the removed workspace's own project on its host", async () => {
    const runtime = new OrcaRuntimeService()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exposes the protected scoped lookup the read uses so the test can control Git's answer.
    const scopedRuntime = runtime as unknown as {
      resolveExplicitWorktreeIdScoped: (id: string, hostId?: string) => Promise<unknown>
    }
    const scoped = vi.spyOn(scopedRuntime, 'resolveExplicitWorktreeIdScoped')

    scoped.mockResolvedValueOnce(null)
    expect(await runtime.readWorktreeRemovalState(ID, 'local')).toEqual({ state: 'removed' })
    expect(scoped).toHaveBeenCalledWith(ID, 'local')

    scoped.mockResolvedValueOnce({ id: ID })
    expect(await runtime.readWorktreeRemovalState(ID, 'local')).toEqual({ state: 'present' })
  })

  it('reports the branch a retried or resumed local delete kept, which it records without a host', async () => {
    const runtime = new OrcaRuntimeService()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exposes the protected scoped lookup the read uses so the test can control Git's answer.
    const scopedRuntime = runtime as unknown as {
      resolveExplicitWorktreeIdScoped: (id: string, hostId?: string) => Promise<unknown>
    }
    vi.spyOn(scopedRuntime, 'resolveExplicitWorktreeIdScoped').mockResolvedValue(null)
    runtime['preservedBranchCleanup'].remember(
      ID,
      undefined,
      { preservedBranch: { branchName: 'feature', head: 'abc' } },
      undefined,
      undefined
    )

    expect(await runtime.readWorktreeRemovalState(ID, 'local')).toEqual({
      state: 'removed',
      preservedBranch: { branchName: 'feature', head: 'abc' }
    })
  })
})
