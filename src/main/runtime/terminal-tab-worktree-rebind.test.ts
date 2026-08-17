import { describe, expect, it, vi } from 'vitest'
import { rebindRuntimeTabWorktreeMaps } from './terminal-tab-worktree-rebind'

describe('rebindRuntimeTabWorktreeMaps', () => {
  it('moves tab, leaf, and PTY worktree ids without dropping the PTY id', () => {
    const tabs = new Map([['tab-1', { tabId: 'tab-1', worktreeId: 'src' }]])
    const leaves = new Map([
      ['tab-1:leaf-1', { tabId: 'tab-1', worktreeId: 'src', ptyId: 'pty-1' }],
      ['tab-2:leaf-1', { tabId: 'tab-2', worktreeId: 'src', ptyId: 'pty-2' }]
    ])
    const ptys = [{ ptyId: 'pty-1', tabId: 'tab-1', worktreeId: 'src' }]
    const recordPtyWorktree = vi.fn()

    const ptyIds = rebindRuntimeTabWorktreeMaps({
      tabId: 'tab-1',
      destWorktreeId: 'dest',
      tabs,
      leaves,
      ptys,
      recordPtyWorktree
    })

    expect(tabs.get('tab-1')?.worktreeId).toBe('dest')
    expect(leaves.get('tab-1:leaf-1')?.worktreeId).toBe('dest')
    expect(leaves.get('tab-1:leaf-1')?.ptyId).toBe('pty-1')
    expect(leaves.get('tab-2:leaf-1')?.worktreeId).toBe('src')
    expect(ptyIds).toEqual(['pty-1'])
    expect(recordPtyWorktree).toHaveBeenCalledWith('pty-1', 'dest')
  })
})
