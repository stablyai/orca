import { expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { createUnreadBadgeCountSelector } from './unread-badge-count-selector'

// Perf contract (#46026): the store takes several writes a second at 100+ agents. A write may cost the Dock only
// the rows it replaced: remote status and folder activity writes read no worktree rows, and a change inside one
// repo reads only that repo's rows, at 100 and 1,000 worktrees alike.

const ROWS_PER_REPO = 10

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

let rowReads = 0

/** A worktree whose unread flag counts reads, which every count pass must make per row. */
function countedWorktree(index: number, isUnread: boolean): Worktree {
  const repoId = `repo-${Math.floor(index / ROWS_PER_REPO)}`
  const worktree = makeWorktree({ id: `${repoId}::/wt-${index}`, repoId })
  Object.defineProperty(worktree, 'isUnread', {
    get() {
      rowReads += 1
      return isUnread
    },
    enumerable: true
  })
  return worktree
}

type Write = (state: AppState) => AppState

function rowReadsAfter(worktreeCount: number, write: Write): number {
  const buckets: AppState['worktreesByRepo'] = {}
  for (let index = 0; index < worktreeCount; index += 1) {
    const worktree = countedWorktree(index, index % 2 === 0)
    buckets[worktree.repoId] = [...(buckets[worktree.repoId] ?? []), worktree]
  }
  const before: AppState = {
    ...createTestStore().getState(),
    worktreesByRepo: buckets,
    folderWorkspaces: [FOLDER],
    hideWorkspacesFromOtherDevices: true
  }
  const select = createUnreadBadgeCountSelector()
  select(before)
  rowReads = 0
  select(write(before))
  return rowReads
}

const remoteStatusWrite: Write = (state) => ({
  ...state,
  runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId)
})

const folderActivityWrite: Write = (state) => ({
  ...state,
  folderWorkspaces: [{ ...FOLDER, lastActivityAt: 2 }]
})

/** Replaces repo-0's bucket, as a worktree activity stamp or an unread flip does. */
const oneRepoWrite: Write = (state) => ({
  ...state,
  worktreesByRepo: {
    ...state.worktreesByRepo,
    'repo-0': Array.from({ length: ROWS_PER_REPO }, (_, index) => countedWorktree(index, true))
  }
})

it('a remote status write that keeps every device id reads no worktree rows at N and 10N', () => {
  expect(rowReadsAfter(100, remoteStatusWrite)).toBe(0)
  expect(rowReadsAfter(1_000, remoteStatusWrite)).toBe(0)
})

it('a folder activity write reads no worktree rows at N and 10N', () => {
  expect(rowReadsAfter(100, folderActivityWrite)).toBe(0)
  expect(rowReadsAfter(1_000, folderActivityWrite)).toBe(0)
})

it('a write inside one repo reads only that repo at N and 10N', () => {
  expect(rowReadsAfter(100, oneRepoWrite)).toBe(ROWS_PER_REPO)
  expect(rowReadsAfter(1_000, oneRepoWrite)).toBe(ROWS_PER_REPO)
})
