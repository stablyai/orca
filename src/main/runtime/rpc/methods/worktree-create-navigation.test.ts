import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

const repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git' as const,
  executionHostId: 'ssh:ssh-target-1' as const
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const passthroughDedupe = <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
  run()

describe('worktree.create navigation authority', () => {
  it.each([
    ['runtime', 'caller'],
    ['mobile', 'caller']
  ] as const)(
    'scopes create activation to the caller for a paired %s client',
    async (clientKind, expected) => {
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        dedupeWorktreeCreate: passthroughDedupe,
        showRepo: vi.fn().mockResolvedValue(repo),
        createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

      await dispatcher.dispatchStreaming(
        makeRequest('worktree.create', { repo: 'repo-1', name: 'feature', activate: true }),
        () => {},
        { clientKind, pairedDeviceId: 'device-1', connectionId: 'conn-1' }
      )

      expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ activate: true, navigation: expected })
      )
    }
  )

  it('honors an explicit follow navigation on create', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      showRepo: vi.fn().mockResolvedValue(repo),
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'feature',
        activate: true,
        navigation: 'clients'
      }),
      () => {},
      { clientKind: 'runtime', pairedDeviceId: 'device-1', connectionId: 'conn-1' }
    )

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ navigation: 'clients' })
    )
  })

  it('keeps an explicit all-surface reveal from a paired caller', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      showRepo: vi.fn().mockResolvedValue(repo),
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('worktree.create', {
        repo: 'repo-1',
        name: 'feature',
        activate: true,
        navigation: 'all'
      }),
      () => {},
      { clientKind: 'runtime', pairedDeviceId: 'device-1', connectionId: 'conn-1' }
    )

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ navigation: 'all' })
    )
  })
})
