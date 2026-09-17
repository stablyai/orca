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

describe('worktree RPC workspace status resolution', () => {
  const board = [
    { id: 'todo', label: 'Todo' },
    { id: 'status-5-2', label: 'QA' }
  ]

  function makeRuntime(overrides: Record<string, unknown> = {}): OrcaRuntimeService {
    return {
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: passthroughDedupe,
      showRepo: vi.fn().mockResolvedValue(repo),
      getUIState: vi.fn(() => ({ workspaceStatuses: board })),
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } }),
      updateManagedWorktreeMeta: vi.fn().mockResolvedValue({ id: 'wt-1' }),
      ...overrides
    } as unknown as OrcaRuntimeService
  }

  it('sets a renamed column by its name', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.set', { worktree: 'id:wt-1', workspaceStatus: 'QA' })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ workspaceStatus: 'status-5-2' })
    )
  })

  it('creates a workspace in a renamed column by its name', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      makeRequest('worktree.create', { repo: 'repo-1', name: 'feature', workspaceStatus: 'qa' })
    )

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceStatus: 'status-5-2' })
    )
  })

  it('rejects an unknown workspace status instead of storing it', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.set', { worktree: 'id:wt-1', workspaceStatus: 'nope' })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: expect.stringContaining('status-5-2 (QA)') }
    })
    expect(runtime.updateManagedWorktreeMeta).not.toHaveBeenCalled()
  })

  it('leaves the workspace status alone when the caller omits it', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.set', { worktree: 'id:wt-1', comment: 'hi' })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.updateManagedWorktreeMeta).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ workspaceStatus: undefined })
    )
  })
})
