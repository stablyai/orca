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
})
