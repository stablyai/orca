import { describe, expect, it } from 'vitest'
import {
  removeTransferredTerminalSession,
  restoreTransferredTerminalSession
} from './terminal-window-transfer-session-patch'
import { terminalWindowSeed, terminalWindowSession } from './terminal-window-transfer-test-fixture'

describe('terminal window transfer target session rollback', () => {
  it('restores prior tab-scoped backing values instead of deleting them', () => {
    const prior = terminalWindowSession(true)
    const oldTab = { ...terminalWindowSeed().tab, title: 'Old terminal' }
    const oldLayout = {
      ...terminalWindowSeed().layout,
      titlesByLeafId: { 'leaf-1': 'Old layout' }
    }
    prior.tabsByWorktree['wt-1'] = [oldTab]
    prior.terminalLayoutsByTabId['tab-1'] = oldLayout
    prior.unifiedTabs!['wt-1']![0] = {
      ...prior.unifiedTabs!['wt-1']![0]!,
      label: 'Old unified'
    }
    prior.tabGroups!['wt-1']![0] = {
      ...prior.tabGroups!['wt-1']![0]!,
      activeTabId: 'tab-1',
      recentTabIds: ['tab-1']
    }
    prior.remoteSessionIdsByTabId!['tab-1'] = 'remote-old'
    const staged = terminalWindowSession(true)
    staged.tabGroups!['wt-1']![0]!.activeTabId = null
    staged.openFilesByWorktree = {
      'wt-1': [
        {
          filePath: '/tmp/repo-1/concurrent.ts',
          relativePath: 'concurrent.ts',
          worktreeId: 'wt-1',
          language: 'typescript'
        }
      ]
    }

    const restored = removeTransferredTerminalSession(staged, prior, terminalWindowSeed())

    expect(restored.tabsByWorktree['wt-1']?.[0]).toEqual(oldTab)
    expect(restored.terminalLayoutsByTabId['tab-1']).toEqual(oldLayout)
    expect(restored.unifiedTabs?.['wt-1']?.[0]?.label).toBe('Old unified')
    expect(restored.tabGroups?.['wt-1']?.[0]).toMatchObject({
      activeTabId: 'tab-1',
      recentTabIds: ['tab-1'],
      tabOrder: ['tab-1']
    })
    expect(restored.remoteSessionIdsByTabId?.['tab-1']).toBe('remote-old')
    expect(restored.openFilesByWorktree).toEqual(staged.openFilesByWorktree)
  })

  it('removes a ghost group by workspace even when another workspace reused its id', () => {
    const prior = terminalWindowSession(false)
    prior.tabGroups = {
      workspaceB: [
        {
          id: 'group-1',
          worktreeId: 'workspaceB',
          activeTabId: 'tab-b',
          tabOrder: ['tab-b'],
          recentTabIds: ['tab-b']
        }
      ]
    }
    prior.tabGroupLayouts = { workspaceB: { type: 'leaf', groupId: 'group-1' } }
    const current = structuredClone(prior)
    current.tabGroups!.workspaceA = [
      {
        id: 'group-1',
        worktreeId: 'workspaceA',
        activeTabId: 'tab-1',
        tabOrder: ['tab-1'],
        recentTabIds: ['tab-1']
      }
    ]
    current.tabGroupLayouts!.workspaceA = { type: 'leaf', groupId: 'group-1' }

    const restored = removeTransferredTerminalSession(current, prior, terminalWindowSeed())

    expect(restored.tabGroups?.workspaceA).toEqual([])
    expect(restored.tabGroupLayouts?.workspaceA).toBeUndefined()
    expect(restored.tabGroups?.workspaceB).toEqual(prior.tabGroups.workspaceB)
    expect(restored.tabGroupLayouts?.workspaceB).toEqual(prior.tabGroupLayouts.workspaceB)
  })

  it('restores prior selectors when source compensation left them empty', () => {
    const prior = terminalWindowSession(true)
    prior.activeTabId = 'tab-1'
    prior.activeTabIdByWorktree = { 'wt-1': 'tab-1' }
    const current = terminalWindowSession(false)
    current.activeRepoId = null
    current.activeWorktreeId = null
    current.activeTabId = null
    current.activeTabIdByWorktree = { 'wt-1': null }
    current.activeGroupIdByWorktree = {}

    const restored = restoreTransferredTerminalSession(current, prior, terminalWindowSeed())

    expect(restored).toMatchObject({
      activeRepoId: prior.activeRepoId,
      activeWorktreeId: prior.activeWorktreeId,
      activeTabId: 'tab-1',
      activeTabIdByWorktree: { 'wt-1': 'tab-1' },
      activeGroupIdByWorktree: { 'wt-1': 'group-1' }
    })
  })

  it('restores target selectors that still point at removed transfer entities', () => {
    const prior = terminalWindowSession(false)
    prior.activeRepoId = 'repo-before'
    prior.activeWorktreeId = 'folder:before'
    prior.activeTabId = 'tab-before'
    prior.activeTabIdByWorktree = { 'folder:before': 'tab-before' }
    prior.activeGroupIdByWorktree = { 'folder:before': 'group-before' }
    prior.tabsByWorktree['folder:before'] = [
      {
        ...terminalWindowSeed().tab,
        id: 'tab-before',
        ptyId: 'pty-before',
        worktreeId: 'folder:before'
      }
    ]
    prior.tabGroups = {
      'folder:before': [
        {
          id: 'group-before',
          worktreeId: 'folder:before',
          activeTabId: 'tab-before',
          tabOrder: ['tab-before']
        }
      ]
    }
    const current = terminalWindowSession(true)
    current.tabsByWorktree['folder:before'] = structuredClone(
      prior.tabsByWorktree['folder:before']!
    )
    current.tabGroups!['folder:before'] = structuredClone(prior.tabGroups['folder:before']!)
    current.activeRepoId = terminalWindowSeed().repo.id
    current.activeWorktreeId = terminalWindowSeed().worktreeId
    current.activeTabId = terminalWindowSeed().tabId
    current.activeTabIdByWorktree = {
      'folder:before': 'tab-before',
      'wt-1': terminalWindowSeed().tabId
    }
    current.activeGroupIdByWorktree = {
      'folder:before': 'group-before',
      'wt-1': terminalWindowSeed().group.id
    }

    const restored = removeTransferredTerminalSession(current, prior, terminalWindowSeed())

    expect(restored).toMatchObject({
      activeRepoId: 'repo-before',
      activeWorktreeId: 'folder:before',
      activeTabId: 'tab-before',
      activeTabIdByWorktree: { 'folder:before': 'tab-before' },
      activeGroupIdByWorktree: { 'folder:before': 'group-before' }
    })
  })

  it('preserves concurrent target selectors that still point at live entities', () => {
    const prior = terminalWindowSession(false)
    const current = terminalWindowSession(true)
    current.tabsByWorktree['wt-1']!.push({
      ...terminalWindowSeed().tab,
      id: 'tab-live',
      ptyId: 'pty-live'
    })
    current.tabGroups!['wt-1']!.push({
      id: 'group-live',
      worktreeId: 'wt-1',
      activeTabId: 'tab-live',
      tabOrder: ['tab-live']
    })
    current.activeRepoId = 'repo-live'
    current.activeWorktreeId = 'wt-1'
    current.activeTabId = 'tab-live'
    current.activeTabIdByWorktree = { 'wt-1': 'tab-live' }
    current.activeTabTypeByWorktree = { 'wt-1': 'terminal' }
    current.activeGroupIdByWorktree = { 'wt-1': 'group-live' }

    const restored = removeTransferredTerminalSession(current, prior, terminalWindowSeed())

    expect(restored).toMatchObject({
      activeRepoId: 'repo-live',
      activeWorktreeId: 'wt-1',
      activeTabId: 'tab-live',
      activeTabIdByWorktree: { 'wt-1': 'tab-live' },
      activeTabTypeByWorktree: { 'wt-1': 'terminal' },
      activeGroupIdByWorktree: { 'wt-1': 'group-live' }
    })
  })
})
