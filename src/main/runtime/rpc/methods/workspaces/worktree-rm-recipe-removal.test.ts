import '../../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { WORKTREE_METHODS } from './worktree'
import { classifyRuntimeLongPoll } from '../../server/runtime-rpc-long-poll'

const WORKTREE_ID = 'repo-1::/repo/wt'

function makeRuntime(owned: boolean) {
  const removeRecipeWorkspace = vi.fn().mockResolvedValue({ removed: true })
  const removeManagedWorktree = vi.fn().mockResolvedValue({})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method worktree.rm reaches.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    listRepos: () => [{ id: 'repo-1', path: '/repo', executionHostId: 'local' }],
    showManagedWorktree: vi.fn().mockResolvedValue({ id: WORKTREE_ID, hostId: 'local' }),
    ownsRecipeWorkspaceRemoval: vi.fn().mockReturnValue(owned),
    removeRecipeWorkspace,
    removeManagedWorktree
  } as unknown as OrcaRuntimeService
  return { runtime, removeRecipeWorkspace, removeManagedWorktree }
}

async function removeOverRpc(runtime: OrcaRuntimeService) {
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
  return dispatcher.dispatch({
    id: 'req-1',
    authToken: 'tok',
    method: 'worktree.rm',
    params: {
      worktree: `id:${WORKTREE_ID}`,
      hostId: 'runtime:env-a',
      force: true,
      destroyHost: true
    }
  })
}

describe('worktree.rm of a recipe-provisioned workspace', () => {
  it('destroys the environment through the provisioning host instead of deleting locally', async () => {
    const { runtime, removeRecipeWorkspace, removeManagedWorktree } = makeRuntime(true)

    const response = await removeOverRpc(runtime)

    expect(response).toMatchObject({ ok: true, result: { removed: true } })
    expect(removeRecipeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: `id:${WORKTREE_ID}`, hostId: 'runtime:env-a' })
    )
    expect(removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('leaves workspaces without an owned recipe on the ordinary removal path', async () => {
    const { runtime, removeRecipeWorkspace, removeManagedWorktree } = makeRuntime(false)

    await removeOverRpc(runtime)

    expect(removeRecipeWorkspace).not.toHaveBeenCalled()
    expect(removeManagedWorktree).toHaveBeenCalled()
  })
})

describe('worktree.rm long-poll admission', () => {
  const request = { id: 'req', authToken: 'tok', method: 'worktree.rm' }
  it('keeps a recipe workspace removal alive while its destroy runs', () => {
    expect(
      classifyRuntimeLongPoll({
        ...request,
        params: { worktree: `id:${WORKTREE_ID}`, hostId: 'runtime:env-a', destroyHost: true }
      })
    ).toBe('wait')
  })
  it('leaves ordinary removals as short calls', () => {
    expect(
      classifyRuntimeLongPoll({ ...request, params: { worktree: 'name:task', hostId: 'local' } })
    ).toBeNull()
    expect(
      classifyRuntimeLongPoll({
        ...request,
        params: { worktree: `id:${WORKTREE_ID}`, hostId: 'runtime:env-a' }
      })
    ).toBeNull()
  })
})
