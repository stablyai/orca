import { describe, expect, it } from 'vitest'
import { getLiveWorktreeDisplayName } from './worktree-display-name'

describe('getLiveWorktreeDisplayName', () => {
  it('uses the host-list display name for the current worktree', () => {
    expect(
      getLiveWorktreeDisplayName(
        [
          { worktreeId: 'wt-1', displayName: 'Old' },
          { worktreeId: 'wt-2', displayName: 'Auto Generated Name' }
        ],
        'wt-2'
      )
    ).toBe('Auto Generated Name')
  })

  it('matches worktree.show payloads keyed by id', () => {
    expect(getLiveWorktreeDisplayName([{ id: 'wt-1', displayName: 'Settled Name' }], 'wt-1')).toBe(
      'Settled Name'
    )
  })

  it('falls back to repo only when the display name is blank', () => {
    expect(
      getLiveWorktreeDisplayName([{ worktreeId: 'wt-1', displayName: '  ', repo: 'orca' }], 'wt-1')
    ).toBe('orca')
  })

  it('ignores snapshots that do not contain the current worktree', () => {
    expect(getLiveWorktreeDisplayName([{ worktreeId: 'wt-1', displayName: 'Other' }], 'wt-2')).toBe(
      null
    )
  })
})
