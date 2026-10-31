import { expect, it, vi } from 'vitest'
import '../runtime/orca-runtime-test-mocks.spec'
import { store, TEST_REPO_ID } from '../runtime/orca-runtime-test-fixtures.spec'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { removeOrphanOrFolderWorktree } from '../runtime/workspaces/workspace-registration-removal'

vi.mock('../runtime/workspaces/workspace-registration-removal', () => ({
  removeOrphanOrFolderWorktree: vi.fn(async () => ({}))
}))

it.each(['success', 'refusal'])(
  'preserves a remote removal %s when no local server fence was acquired',
  async (outcome) => {
    const repo = {
      ...store.getRepo(TEST_REPO_ID)!,
      connectionId: 'remote',
      executionHostId: 'ssh:remote' as const
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [repo],
      getRepo: () => repo
    })
    const id = `${TEST_REPO_ID}::/tmp/remote`
    Object.assign(runtime, {
      resolveWorktreeRemovalTarget: async () => ({ id, repoId: TEST_REPO_ID, path: '/tmp/remote' })
    })
    const fence = vi.spyOn(runtime.workspaceServers, 'beginWorktreeRemoval')
    if (outcome === 'refusal') {
      vi.mocked(removeOrphanOrFolderWorktree).mockRejectedValueOnce(new Error('expected refusal'))
      await expect(runtime.removeManagedWorktree(id, { hostId: 'ssh:remote' })).rejects.toThrow(
        'expected refusal'
      )
    } else {
      vi.mocked(removeOrphanOrFolderWorktree).mockResolvedValueOnce({})
      await expect(runtime.removeManagedWorktree(id, { hostId: 'ssh:remote' })).resolves.toEqual({})
    }
    expect(fence).not.toHaveBeenCalled()
  }
)
