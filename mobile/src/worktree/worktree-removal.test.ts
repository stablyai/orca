import { describe, expect, it, vi } from 'vitest'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcResponse } from '../transport/types'
import type { Worktree } from './workspace-list-types'
import {
  STALE_SNAPSHOT_GENERATION,
  WORKTREE_REMOVAL_AMBIGUOUS_GRACE_MS,
  WORKTREE_REMOVE_TIMEOUT_MS,
  createWorktreeRemovalTracker,
  getWorktreeRemovalTracker,
  type RemoveWorktreeArgs
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

function success(): RpcResponse {
  return { id: '1', ok: true, result: { removed: true }, _meta: { runtimeId: 'runtime-1' } }
}

function failure(message: string): RpcResponse {
  return {
    id: '1',
    ok: false,
    error: { code: 'internal', message },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function timeout(): Error {
  return markRpcDeliveryUnknown(new Error('Request timed out: worktree.rm'))
}

function listHarness(initial: Worktree[]) {
  let list = initial
  return {
    get ids(): string[] {
      return list.map((entry) => entry.worktreeId)
    },
    update: (updater: (value: Worktree[]) => Worktree[]) => {
      list = updater(list)
    }
  }
}

type RemoveOverrides = Partial<RemoveWorktreeArgs> & { response?: RpcResponse; rejectWith?: Error }

function removeArgs(worktreeId: string, overrides: RemoveOverrides = {}): RemoveWorktreeArgs {
  const { response, rejectWith, ...rest } = overrides
  const sendRequest = rejectWith
    ? vi.fn().mockRejectedValue(rejectWith)
    : vi.fn().mockResolvedValue(response ?? success())
  return {
    worktree: worktree(worktreeId),
    client: { sendRequest },
    updateWorktreeLists: () => {},
    refresh: () => {},
    onFailure: () => {},
    ...rest
  }
}

describe('worktree removal tracker', () => {
  it('sends worktree.rm with the desktop-sized timeout and drops the row', async () => {
    const tracker = createWorktreeRemovalTracker()
    const lists = listHarness([worktree('wt-1'), worktree('wt-2')])
    const sendRequest = vi.fn().mockResolvedValue(success())
    const onFailure = vi.fn()
    const refresh = vi.fn()

    await tracker.remove(
      removeArgs('wt-1', {
        client: { sendRequest },
        updateWorktreeLists: lists.update,
        onFailure,
        refresh
      })
    )

    expect(sendRequest).toHaveBeenCalledWith(
      'worktree.rm',
      { worktree: 'id:wt-1', force: true },
      { timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS }
    )
    expect(lists.ids).toEqual(['wt-2'])
    expect(onFailure).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('hides the worktree in a read issued before the delete landed', async () => {
    const tracker = createWorktreeRemovalTracker()
    // The poll that was already in flight when the user confirmed the delete.
    const inFlight = tracker.beginSnapshot()

    await tracker.remove(removeArgs('wt-1'))

    const stale = [worktree('wt-1'), worktree('wt-2')]
    expect(tracker.reconcile(stale, inFlight).map((entry) => entry.worktreeId)).toEqual(['wt-2'])
  })

  it('hides the worktree for the whole delete, not just one poll', async () => {
    const tracker = createWorktreeRemovalTracker()
    let settle = (_: RpcResponse) => {}
    const sendRequest = vi.fn().mockReturnValue(
      new Promise<RpcResponse>((resolve) => {
        settle = resolve
      })
    )
    const removal = tracker.remove(removeArgs('wt-1', { client: { sendRequest } }))

    // The host truthfully keeps reporting the worktree until the removal finishes.
    for (let poll = 0; poll < 5; poll += 1) {
      const snapshot = [worktree('wt-1')]
      expect(tracker.reconcile(snapshot, tracker.beginSnapshot())).toHaveLength(0)
    }

    settle(success())
    await removal
  })

  it('stops hiding a worktree recreated at the same path after the delete', async () => {
    const tracker = createWorktreeRemovalTracker()
    // Why (regression): ids are path-derived and reused. Clearing only when the host stops
    // reporting the id hid a freshly recreated workspace until the grace period lapsed.
    await tracker.remove(removeArgs('wt-1'))

    const recreated = [worktree('wt-1')]
    expect(tracker.reconcile(recreated, tracker.beginSnapshot())).toBe(recreated)
  })

  it('keeps hiding a confirmed delete across reads issued before it resolved', async () => {
    const tracker = createWorktreeRemovalTracker()
    const stale = tracker.beginSnapshot()

    await tracker.remove(removeArgs('wt-1'))

    expect(tracker.reconcile([worktree('wt-1')], stale)).toHaveLength(0)
  })

  it('never lets a replayed cache settle a pending delete', async () => {
    const tracker = createWorktreeRemovalTracker()

    await tracker.remove(removeArgs('wt-1'))

    const cached = [worktree('wt-1')]
    expect(tracker.reconcile(cached, STALE_SNAPSHOT_GENERATION)).toHaveLength(0)
  })

  it('does not let a cache written during the delete settle it', async () => {
    const tracker = createWorktreeRemovalTracker()
    let settle = (_: RpcResponse) => {}
    const sendRequest = vi.fn().mockReturnValue(
      new Promise<RpcResponse>((resolve) => {
        settle = resolve
      })
    )
    const removal = tracker.remove(removeArgs('wt-1', { client: { sendRequest } }))

    // Why (regression): the screen caches the *reconciled* list, so remounting mid-delete
    // replays a cache the row is already missing from. Treating that absence as the host
    // confirming the delete dropped the pending state, and the next poll — with the host
    // still mid-removal and still reporting the worktree — put the row back.
    const cachedDuringDelete = [worktree('wt-2')]
    tracker.reconcile(cachedDuringDelete, STALE_SNAPSHOT_GENERATION)

    const stillRemoving = [worktree('wt-1'), worktree('wt-2')]
    expect(
      tracker.reconcile(stillRemoving, tracker.beginSnapshot()).map((entry) => entry.worktreeId)
    ).toEqual(['wt-2'])

    settle(success())
    await removal
  })

  it('keeps the row hidden for the grace period after an rm times out', async () => {
    const tracker = createWorktreeRemovalTracker()
    const lists = listHarness([worktree('wt-1')])
    const onFailure = vi.fn()
    // Why (regression): the timeout fires a full WORKTREE_REMOVE_TIMEOUT_MS after the
    // request starts. A grace period measured from the request would already be spent,
    // so the row reappeared the instant the delete timed out.
    let clock = 1000
    const sendRequest = vi.fn().mockImplementation(() => {
      clock += WORKTREE_REMOVE_TIMEOUT_MS
      return Promise.reject(timeout())
    })

    await tracker.remove(
      removeArgs('wt-1', {
        client: { sendRequest },
        updateWorktreeLists: lists.update,
        onFailure,
        now: () => clock
      })
    )

    const stubborn = [worktree('wt-1')]
    expect(lists.ids).toEqual([])
    expect(onFailure).not.toHaveBeenCalled()
    expect(tracker.reconcile(stubborn, tracker.beginSnapshot(), clock)).toHaveLength(0)
    expect(
      tracker.reconcile(
        stubborn,
        tracker.beginSnapshot(),
        clock + WORKTREE_REMOVAL_AMBIGUOUS_GRACE_MS - 1
      )
    ).toHaveLength(0)
    expect(
      tracker.reconcile(
        stubborn,
        tracker.beginSnapshot(),
        clock + WORKTREE_REMOVAL_AMBIGUOUS_GRACE_MS
      )
    ).toBe(stubborn)
  })

  it('leaves an ambiguous delete gone once the host confirms it', async () => {
    const tracker = createWorktreeRemovalTracker()

    await tracker.remove(removeArgs('wt-1', { rejectWith: timeout(), now: () => 1000 }))

    expect(tracker.reconcile([worktree('wt-2')], tracker.beginSnapshot(), 1500)).toHaveLength(1)
    const recreated = [worktree('wt-1')]
    expect(tracker.reconcile(recreated, tracker.beginSnapshot(), 1600)).toBe(recreated)
  })

  it('restores the row and reports the host error when the delete is rejected', async () => {
    const tracker = createWorktreeRemovalTracker()
    const lists = listHarness([worktree('wt-1')])
    const onFailure = vi.fn()

    await tracker.remove(
      removeArgs('wt-1', {
        response: failure('worktree is locked'),
        updateWorktreeLists: lists.update,
        onFailure
      })
    )

    expect(lists.ids).toEqual(['wt-1'])
    expect(onFailure).toHaveBeenCalledWith('worktree is locked')
    expect(tracker.reconcile([worktree('wt-1')], tracker.beginSnapshot())).toHaveLength(1)
  })

  it('coalesces a double-fired delete into one request', async () => {
    const tracker = createWorktreeRemovalTracker()
    const lists = listHarness([worktree('wt-1')])
    const onFailure = vi.fn()
    let settle = (_: RpcResponse) => {}
    const sendRequest = vi.fn().mockReturnValue(
      new Promise<RpcResponse>((resolve) => {
        settle = resolve
      })
    )
    const args = removeArgs('wt-1', {
      client: { sendRequest },
      updateWorktreeLists: lists.update,
      onFailure
    })

    // Why (regression): the confirm button can fire twice before the sheet unmounts. The
    // loser's rollback would otherwise re-add the row and drop the winner's pending state.
    const first = tracker.remove(args)
    const second = tracker.remove(args)
    expect(second).toBe(first)

    settle(failure('worktree is locked'))
    await Promise.all([first, second])

    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(lists.ids).toEqual(['wt-1'])
  })

  it('accepts a fresh delete once the previous attempt settled', async () => {
    const tracker = createWorktreeRemovalTracker()
    const lists = listHarness([worktree('wt-1')])

    await tracker.remove(
      removeArgs('wt-1', {
        response: failure('worktree is locked'),
        updateWorktreeLists: lists.update
      })
    )
    await tracker.remove(removeArgs('wt-1', { updateWorktreeLists: lists.update }))

    expect(lists.ids).toEqual([])
  })

  it('restores the row once, even if a poll already put it back', async () => {
    const tracker = createWorktreeRemovalTracker()
    const lists = listHarness([worktree('wt-1')])

    await tracker.remove(
      removeArgs('wt-1', {
        response: failure('worktree is locked'),
        updateWorktreeLists: (updater) => {
          lists.update(updater)
          // A poll resolving between the optimistic drop and the rollback.
          lists.update((list) =>
            list.some((entry) => entry.worktreeId === 'wt-1') ? list : [...list, worktree('wt-1')]
          )
        }
      })
    )

    expect(lists.ids).toEqual(['wt-1'])
  })

  it('restores the row and reports the message when the request throws', async () => {
    const tracker = createWorktreeRemovalTracker()
    const lists = listHarness([worktree('wt-1')])
    const onFailure = vi.fn()

    await tracker.remove(
      removeArgs('wt-1', {
        rejectWith: new Error('repo_not_found'),
        updateWorktreeLists: lists.update,
        onFailure
      })
    )

    expect(lists.ids).toEqual(['wt-1'])
    expect(onFailure).toHaveBeenCalledWith('repo_not_found')
  })

  it('refreshes after every outcome so the list re-sorts from the host', async () => {
    const tracker = createWorktreeRemovalTracker()
    const refresh = vi.fn()

    await tracker.remove(removeArgs('wt-1', { rejectWith: new Error('boom'), refresh }))

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('leaves untouched snapshots referentially stable', () => {
    const tracker = createWorktreeRemovalTracker()
    const snapshot = [worktree('wt-1')]

    expect(tracker.reconcile(snapshot, tracker.beginSnapshot())).toBe(snapshot)
  })

  it('keeps one host cached tracker per hostId so a remount remembers a pending delete', async () => {
    // Why: worktree ids are only unique per host, and the list screen unmounts on
    // navigation and is reused across hostIds.
    const removal = getWorktreeRemovalTracker('host-a').remove(removeArgs('wt-1'))
    await removal

    const remounted = getWorktreeRemovalTracker('host-a')
    expect(remounted).toBe(getWorktreeRemovalTracker('host-a'))
    expect(remounted.reconcile([worktree('wt-1')], STALE_SNAPSHOT_GENERATION)).toHaveLength(0)

    const otherHost = [worktree('wt-1')]
    expect(
      getWorktreeRemovalTracker('host-b').reconcile(otherHost, STALE_SNAPSHOT_GENERATION)
    ).toBe(otherHost)
  })
})
