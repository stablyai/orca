import '../../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'
import { WorktreeCreateExactNameTakenError } from '../../../../../shared/new-workspace/worktree-create-collision'

// The folder shortcut opens the composer only on this code; runtime_error would toast instead.
it('keeps the exact-name refusal code on worktree.create', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create handler reads only these members.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    showRepo: vi.fn().mockResolvedValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 1,
      kind: 'git'
    }),
    dedupeWorktreeCreate: <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
      run(),
    createManagedWorktree: vi
      .fn()
      .mockRejectedValue(new WorktreeCreateExactNameTakenError('"child" is already taken.'))
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

  const response = await dispatcher.dispatch({
    id: 'req-1',
    authToken: 'tok',
    method: 'worktree.create',
    params: { repo: 'repo-1', name: 'child', branchIntent: 'create-exact' }
  })

  expect(response).toMatchObject({ ok: false, error: { code: 'worktree_create_exact_name_taken' } })
})
