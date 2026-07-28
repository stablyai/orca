import { describe, expect, it, vi } from 'vitest'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../transport/types'
import type { Worktree } from './workspace-list-types'
import {
  WORKTREE_REMOVAL_TOMBSTONE_TTL_MS,
  WORKTREE_REMOVE_TIMEOUT_MS,
  createWorktreeRemovalTracker
} from './worktree-removal'

function worktree(worktreeId: string): Worktree {
  return {
    worktreeId,
    repoId: 'repo-1',
    repo: 'orca',
    branch: `feature/${worktreeId}`,
    displayName: worktreeId,
    path: `/tmp/orca/worktrees/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

function success(result: unknown = { removed: true }): RpcResponse {
  return { id: '1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function failure(message: string): RpcResponse {
  return {
    id: '1',
    ok: false,
    error: { code: 'internal', message },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function listHarness(initial: Worktree[]) {
  let list = initial
  return {
    get current(): Worktree[] {
      return list
    },
    update: (updater: (value: Worktree[]) => Worktree[]) => {
      list = updater(list)
    }
  }
}

describe('createWorktreeRemovalTracker', () => {
  it('sends worktree.rm with the desktop-sized timeout and keeps the row hidden', async () => {
    const tracker = createWorktreeRemovalTracker()
    const lists = listHarness([worktree('wt-1'), worktree('wt-2')])
    const sendRequest = vi.fn().mockResolvedValue(success())
    const refresh = vi.fn()
    const onFailure = vi.fn()

    await tracker.remove({
      worktree: worktree('wt-1'),
      client: { sendRequest },
      updateWorktreeLists: lists.update,
      refresh,
      onFailure
    })

    expect(sendRequest).toHaveBeenCalledWith(
      'worktree.rm',
      { worktree: 'id:wt-1', force: true },
      { timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS }
    )
    expect(lists.current.map((entry) => entry.worktreeId)).toEqual(['wt-2'])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('drops a deleted worktree from a snapshot the host took before the delete landed', async () => {
    const tracker = createWorktreeRemovalTracker()
    const lists = listHarness([worktree('wt-1'), worktree('wt-2')])

    await tracker.remove({
      worktree: worktree('wt-1'),
      client: { sendRequest: vi.fn().mockResolvedValue(success()) },
      updateWorktreeLists: lists.update,
      refresh: () => {},
      onFailure: () => {},
      now: () => 1000
    })

    const stale = [worktree('wt-1'), worktree('wt-2')]
    expect(tracker.reconcile(stale, 1500).map((entry) => entry.worktreeId)).toEqual(['wt-2'])
  })

  it('stops hiding a worktree once the host confirms it is gone', async () => {
    const tracker = createWorktreeRemovalTracker()

    await tracker.remove({
      worktree: worktree('wt-1'),
      client: { sendRequest: vi.fn().mockResolvedValue(success()) },
      updateWorktreeLists: () => {},
      refresh: () => {},
      onFailure: () => {},
      now: () => 1000
    })

    expect(tracker.reconcile([worktree('wt-2')], 1500)).toHaveLength(1)
    // The worktree id is untracked again, so a same-id workspace recreated later shows up.
    const recreated = [worktree('wt-1'), worktree('wt-2')]
    expect(tracker.reconcile(recreated, 1600)).toBe(recreated)
  })

  it('stops hiding a worktree the host keeps reporting past the tombstone TTL', async () => {
    const tracker = createWorktreeRemovalTracker()

    await tracker.remove({
      worktree: worktree('wt-1'),
      client: { sendRequest: vi.fn().mockResolvedValue(success()) },
      updateWorktreeLists: () => {},
      refresh: () => {},
      onFailure: () => {},
      now: () => 1000
    })

    const stubborn = [worktree('wt-1')]
    expect(tracker.reconcile(stubborn, 1000 + WORKTREE_REMOVAL_TOMBSTONE_TTL_MS - 1)).toHaveLength(
      0
    )
    expect(tracker.reconcile(stubborn, 1000 + WORKTREE_REMOVAL_TOMBSTONE_TTL_MS)).toBe(stubborn)
  })

  it('restores the row and reports the host error when the delete is rejected', async () => {
    const tracker = createWorktreeRemovalTracker()
    const lists = listHarness([worktree('wt-1')])
    const onFailure = vi.fn()

    await tracker.remove({
      worktree: worktree('wt-1'),
      client: { sendRequest: vi.fn().mockResolvedValue(failure('worktree is locked')) },
      updateWorktreeLists: lists.update,
      refresh: () => {},
      onFailure
    })

    expect(lists.current.map((entry) => entry.worktreeId)).toEqual(['wt-1'])
    expect(onFailure).toHaveBeenCalledWith('worktree is locked')
    expect(tracker.reconcile([worktree('wt-1')])).toHaveLength(1)
  })

  it('restores the row and reports the message when the request throws', async () => {
    const tracker = createWorktreeRemovalTracker()
    const lists = listHarness([worktree('wt-1')])
    const onFailure = vi.fn()

    await tracker.remove({
      worktree: worktree('wt-1'),
      client: { sendRequest: vi.fn().mockRejectedValue(new Error('repo_not_found')) },
      updateWorktreeLists: lists.update,
      refresh: () => {},
      onFailure
    })

    expect(lists.current).toHaveLength(1)
    expect(onFailure).toHaveBeenCalledWith('repo_not_found')
  })

  it('keeps the row hidden when delivery is unknown, since the host may still be deleting', async () => {
    const tracker = createWorktreeRemovalTracker()
    const lists = listHarness([worktree('wt-1')])
    const onFailure = vi.fn()

    await tracker.remove({
      worktree: worktree('wt-1'),
      client: {
        sendRequest: vi
          .fn()
          .mockRejectedValue(markRpcDeliveryUnknown(new Error('Request timed out: worktree.rm')))
      },
      updateWorktreeLists: lists.update,
      refresh: () => {},
      onFailure,
      now: () => 1000
    })

    expect(lists.current).toHaveLength(0)
    expect(onFailure).not.toHaveBeenCalled()
    expect(tracker.reconcile([worktree('wt-1')], 1500)).toHaveLength(0)
  })

  it('refreshes after both outcomes so a rolled-back list re-sorts from the host', async () => {
    const tracker = createWorktreeRemovalTracker()
    const refresh = vi.fn()

    await tracker.remove({
      worktree: worktree('wt-1'),
      client: { sendRequest: vi.fn().mockRejectedValue(new Error('boom')) },
      updateWorktreeLists: () => {},
      refresh,
      onFailure: () => {}
    })

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('leaves untouched snapshots referentially stable', () => {
    const tracker = createWorktreeRemovalTracker()
    const snapshot = [worktree('wt-1')]

    expect(tracker.reconcile(snapshot)).toBe(snapshot)
  })
})
