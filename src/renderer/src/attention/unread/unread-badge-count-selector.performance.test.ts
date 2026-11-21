import { expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { createUnreadBadgeCountSelector } from './unread-badge-count-selector'

// Perf contract (#46026): every remote status write replaces the status map. One that keeps every paired
// device id cannot change which rows the Dock counts, so it must not rescan the fleet.

type Write = (state: AppState) => AppState

function rowReadsAfter(worktreeCount: number, write: Write): number {
  const base = createTestStore().getState()
  const worktrees = Array.from({ length: worktreeCount }, (_, index) =>
    makeWorktree({ id: `repo-1::/wt-${index}`, repoId: 'repo-1', isUnread: index % 2 === 0 })
  )
  let reads = 0
  const countedBuckets = new Proxy<AppState['worktreesByRepo']>(
    { 'repo-1': worktrees },
    {
      get(target, property) {
        reads += 1
        return typeof property === 'string' ? target[property] : undefined
      }
    }
  )
  const before: AppState = {
    ...base,
    worktreesByRepo: countedBuckets,
    hideWorkspacesFromOtherDevices: true
  }
  const select = createUnreadBadgeCountSelector()
  select(before)
  reads = 0
  select(write(before))
  return reads
}

const remoteStatusWrite: Write = (state) => ({
  ...state,
  runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId)
})

it('a remote status write that keeps every device id reads no worktree rows at N and 10N', () => {
  expect(rowReadsAfter(100, remoteStatusWrite)).toBe(0)
  expect(rowReadsAfter(1_000, remoteStatusWrite)).toBe(0)
})
