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
    'resolves create activation from the paired %s client kind',
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

  it('preserves an older CLI request without guessing a missing origin', async () => {
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
        cliProvenanceRequest: {}
      }),
      () => {},
      { clientKind: 'runtime', pairedDeviceId: 'device-1', connectionId: 'conn-1' }
    )

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ navigation: 'all', workOrigin: null })
    )
  })

  it('still scopes a desktop create that carries no CLI marker', async () => {
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
      { clientKind: 'runtime', pairedDeviceId: 'device-1', connectionId: 'conn-1' }
    )

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ navigation: 'caller' })
    )
  })

  it('keeps explicit follow navigation local to its caller', async () => {
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
      expect.objectContaining({ navigation: 'caller' })
    )
  })

  it('keeps explicit all-surface navigation local to its caller', async () => {
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
      expect.objectContaining({ navigation: 'caller' })
    )
  })
})
