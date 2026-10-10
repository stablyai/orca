import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

const repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git' as const
}

describe('worktree.create launch source', () => {
  it('hands the surface that asked for a startup agent to the runtime', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method worktree.create reaches for a create with no provenance request.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
        run(),
      showRepo: vi.fn().mockResolvedValue(repo),
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    // An open label: a surface this host has never heard of must not refuse the create.
    for (const launchSource of ['cli', 'a_surface_added_later']) {
      const response = await dispatcher.dispatch({
        id: 'req-1',
        authToken: 'tok',
        method: 'worktree.create',
        params: { repo: 'repo-1', name: 'agent-startup', startupAgent: 'codex', launchSource }
      })
      expect(response).toMatchObject({ ok: true })
      expect(runtime.createManagedWorktree).toHaveBeenLastCalledWith(
        expect.objectContaining({ startupAgent: 'codex', startupLaunchSource: launchSource })
      )
    }
  })
})
