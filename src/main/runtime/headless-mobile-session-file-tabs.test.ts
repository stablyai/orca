import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import {
  closeHeadlessMobileSessionFileTab,
  openHeadlessMobileSessionFileTab
} from './headless-mobile-session-file-tabs'

const WORKTREE_ID = 'repo::/worktree'

function terminalSnapshot(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'headless:before',
    snapshotVersion: 4,
    activeGroupId: 'group-1',
    activeTabId: 'terminal-1::leaf-1',
    activeTabType: 'terminal',
    tabGroups: [
      {
        id: 'group-1',
        activeTabId: 'terminal-1',
        tabOrder: ['terminal-1'],
        recentTabIds: ['terminal-1']
      }
    ],
    tabs: [
      {
        type: 'terminal',
        id: 'terminal-1::leaf-1',
        parentTabId: 'terminal-1',
        leafId: 'leaf-1',
        title: 'Terminal',
        isActive: true
      }
    ]
  }
}

describe('headless mobile session file tabs', () => {
  it('creates and activates a file tab in the active headless group', () => {
    const opened = openHeadlessMobileSessionFileTab(terminalSnapshot(), {
      worktreeId: WORKTREE_ID,
      filePath: '/worktree/src/app.ts',
      relativePath: 'src/app.ts',
      language: 'plaintext',
      tabId: 'file-1',
      defaultGroupId: 'fallback',
      now: 10
    })

    expect(opened).toMatchObject({
      snapshotVersion: 5,
      activeGroupId: 'group-1',
      activeTabId: 'file-1',
      activeTabType: 'file'
    })
    expect(opened.tabGroups).toEqual([
      {
        id: 'group-1',
        activeTabId: 'file-1',
        tabOrder: ['terminal-1', 'file-1'],
        recentTabIds: ['terminal-1', 'file-1']
      }
    ])
    expect(opened.tabs).toEqual([
      expect.objectContaining({ type: 'terminal', isActive: false }),
      expect.objectContaining({
        type: 'file',
        id: 'file-1',
        title: 'app.ts',
        relativePath: 'src/app.ts',
        isActive: true
      })
    ])
  })

  it('reuses an existing edit tab without duplicating it', () => {
    const first = openHeadlessMobileSessionFileTab(terminalSnapshot(), {
      worktreeId: WORKTREE_ID,
      filePath: '/worktree/src/app.ts',
      relativePath: 'src/app.ts',
      language: 'plaintext',
      tabId: 'file-1',
      defaultGroupId: 'fallback',
      now: 10
    })
    const reopened = openHeadlessMobileSessionFileTab(first, {
      worktreeId: WORKTREE_ID,
      filePath: '/worktree/src/app.ts',
      relativePath: 'src/app.ts',
      language: 'typescript',
      tabId: 'file-2',
      defaultGroupId: 'fallback',
      now: 11
    })

    expect(reopened.tabs.filter((tab) => tab.type === 'file')).toEqual([
      expect.objectContaining({ id: 'file-1', language: 'typescript', isActive: true })
    ])
    expect(reopened.tabGroups?.[0]?.tabOrder).toEqual(['terminal-1', 'file-1'])
  })

  it('keeps staged and unstaged diff tabs distinct from an edit tab', () => {
    const edited = openHeadlessMobileSessionFileTab(terminalSnapshot(), {
      worktreeId: WORKTREE_ID,
      filePath: '/worktree/src/app.ts',
      relativePath: 'src/app.ts',
      language: 'typescript',
      tabId: 'file-edit',
      defaultGroupId: 'fallback',
      now: 10
    })
    const staged = openHeadlessMobileSessionFileTab(edited, {
      worktreeId: WORKTREE_ID,
      filePath: '/worktree/src/app.ts',
      relativePath: 'src/app.ts',
      language: 'typescript',
      mode: 'diff',
      diffSource: 'staged',
      tabId: 'file-staged',
      defaultGroupId: 'fallback',
      now: 11
    })
    const unstaged = openHeadlessMobileSessionFileTab(staged, {
      worktreeId: WORKTREE_ID,
      filePath: '/worktree/src/app.ts',
      relativePath: 'src/app.ts',
      language: 'typescript',
      mode: 'diff',
      diffSource: 'unstaged',
      tabId: 'file-unstaged',
      defaultGroupId: 'fallback',
      now: 12
    })

    expect(unstaged.tabs.filter((tab) => tab.type === 'file')).toEqual([
      expect.objectContaining({ id: 'file-edit', mode: 'edit' }),
      expect.objectContaining({ id: 'file-staged', mode: 'diff', diffSource: 'staged' }),
      expect.objectContaining({
        id: 'file-unstaged',
        mode: 'diff',
        diffSource: 'unstaged',
        isActive: true
      })
    ])
  })

  it('closes a headless file tab and restores the prior terminal', () => {
    const opened = openHeadlessMobileSessionFileTab(terminalSnapshot(), {
      worktreeId: WORKTREE_ID,
      filePath: '/worktree/README.md',
      relativePath: 'README.md',
      language: 'plaintext',
      tabId: 'file-1',
      defaultGroupId: 'fallback',
      now: 10
    })

    const closed = closeHeadlessMobileSessionFileTab(opened, 'file-1', 12)

    expect(closed).toMatchObject({
      snapshotVersion: 6,
      activeGroupId: 'group-1',
      activeTabId: 'terminal-1::leaf-1',
      activeTabType: 'terminal'
    })
    expect(closed.tabGroups?.[0]).toMatchObject({
      activeTabId: 'terminal-1',
      tabOrder: ['terminal-1']
    })
    expect(closed.tabs).toEqual([expect.objectContaining({ type: 'terminal', isActive: true })])
  })
})
