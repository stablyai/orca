import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../shared/constants'
import { shouldScopeTerminalHistoryByWorktree } from './terminal-history-scope-policy'

describe('shouldScopeTerminalHistoryByWorktree', () => {
  it.each([
    ['regular worktree', true, 'repo::/worktree', true],
    ['folder workspace', true, 'folder:/workspace', true],
    ['floating terminal', true, FLOATING_TERMINAL_WORKTREE_ID, false],
    ['disabled setting', false, 'repo::/worktree', false],
    ['missing workspace owner', true, undefined, false]
  ])('%s', (_case, settingEnabled, worktreeId, expected) => {
    expect(shouldScopeTerminalHistoryByWorktree(settingEnabled, worktreeId)).toBe(expected)
  })
})
