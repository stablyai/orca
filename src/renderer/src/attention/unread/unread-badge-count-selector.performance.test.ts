import { expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { createUnreadBadgeCountSelector } from './unread-badge-count-selector'

// Perf contract: terminal title batches replace the tab map several times a second with 100+ agents.
// A write that leaves every unread folder's tabs and the marker maps alone must not re-check any folder's markers.

function folder(id: string): FolderWorkspace {
  return {
    id,
    projectGroupId: 'group-1',
    name: id,
    folderPath: `/folders/${id}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: true,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

function markerReadsOnUnrelatedTitleWrite(unreadFolders: number): number {
  const base = createTestStore().getState()
  const folders = Array.from({ length: unreadFolders }, (_, index) => folder(`folder-${index}`))
  const tabsByWorktree: AppState['tabsByWorktree'] = {
    'wt-1': [makeTab({ id: 'wt-tab', worktreeId: 'wt-1', title: 'before' })]
  }
  const markers: AppState['unreadTerminalTabs'] = {}
  for (const { id } of folders) {
    const key = folderWorkspaceKey(id)
    tabsByWorktree[key] = [makeTab({ id: `${id}-tab`, worktreeId: key })]
    markers[`${id}-tab`] = true
  }
  let reads = 0
  const countedMarkers = new Proxy(markers, {
    get(target, property) {
      reads += 1
      return typeof property === 'string' ? target[property] : undefined
    }
  })
  const before: AppState = {
    ...base,
    folderWorkspaces: folders,
    tabsByWorktree,
    unreadTerminalTabs: countedMarkers
  }
  const select = createUnreadBadgeCountSelector()
  select(before)

  reads = 0
  select({
    ...before,
    tabsByWorktree: {
      ...tabsByWorktree,
      'wt-1': [makeTab({ id: 'wt-tab', worktreeId: 'wt-1', title: 'after' })]
    }
  })
  return reads
}

it('a title write outside unread folders reads no folder markers at N and 10N folders', () => {
  expect(markerReadsOnUnrelatedTitleWrite(100)).toBe(0)
  expect(markerReadsOnUnrelatedTitleWrite(1_000)).toBe(0)
})
