import { describe, expect, it } from 'vitest'
import { removeTransferredTerminalSession } from './terminal-window-transfer-session-patch'
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
})
