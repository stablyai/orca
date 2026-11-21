import { expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { createUnreadBadgeCountSelector } from './unread-badge-count-selector'

// Perf contract (#46026): remote status writes replace the status map and folder activity writes replace the
// folder list. Neither can change which worktrees the Dock counts, so neither may rescan worktree rows.

type Write = (state: AppState) => AppState

const FOLDER: FolderWorkspace = {
  id: 'folder-1',
  projectGroupId: 'group-1',
  name: 'folder-1',
  folderPath: '/folders/folder-1',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}

function worktreeBucketReadsAfter(worktreeCount: number, write: Write): number {
  const base = createTestStore().getState()
  const buckets: AppState['worktreesByRepo'] = {}
  for (let index = 0; index < worktreeCount; index += 1) {
    const repoId = `repo-${index % (worktreeCount / 10)}`
    const worktree = makeWorktree({ id: `${repoId}::/wt-${index}`, repoId, isUnread: true })
    buckets[repoId] = [...(buckets[repoId] ?? []), worktree]
  }
  let reads = 0
  const countedBuckets = new Proxy(buckets, {
    get(target, property) {
      reads += 1
      return typeof property === 'string' ? target[property] : undefined
    }
  })
  const before: AppState = {
    ...base,
    worktreesByRepo: countedBuckets,
    folderWorkspaces: [FOLDER],
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

const folderActivityWrite: Write = (state) => ({
  ...state,
  folderWorkspaces: [{ ...FOLDER, lastActivityAt: 2 }]
})

it('a remote status write that keeps every device id reads no worktree buckets at N and 10N', () => {
  expect(worktreeBucketReadsAfter(100, remoteStatusWrite)).toBe(0)
  expect(worktreeBucketReadsAfter(1_000, remoteStatusWrite)).toBe(0)
})

it('a folder activity write reads no worktree buckets at N and 10N', () => {
  expect(worktreeBucketReadsAfter(100, folderActivityWrite)).toBe(0)
  expect(worktreeBucketReadsAfter(1_000, folderActivityWrite)).toBe(0)
})
