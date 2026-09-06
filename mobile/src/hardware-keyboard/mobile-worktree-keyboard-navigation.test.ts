import { describe, expect, it } from 'vitest'
import type { Worktree } from '../worktree/workspace-list-sections'
import {
  getIndexedKeyboardWorktree,
  getRelativeKeyboardWorktree,
  MobileWorktreeNavigationHistory
} from './mobile-worktree-keyboard-navigation'

function worktree(id: string, sortOrder: number, overrides: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId: id,
    repoId: 'repo',
    repo: 'Repo',
    branch: id,
    displayName: id,
    path: `/tmp/${id}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    sortOrder,
    ...overrides
  }
}

describe('mobile worktree keyboard navigation', () => {
  const rows = [worktree('third', 1), worktree('first', 3), worktree('second', 2)]

  it('cycles in desktop smart order and wraps', () => {
    expect(getRelativeKeyboardWorktree(rows, 'first', 1)?.worktreeId).toBe('second')
    expect(getRelativeKeyboardWorktree(rows, 'third', 1)?.worktreeId).toBe('first')
    expect(getRelativeKeyboardWorktree(rows, 'first', -1)?.worktreeId).toBe('third')
  })

  it('selects visible indices and skips archived rows', () => {
    const withArchived = [...rows, worktree('hidden', 10, { isArchived: true })]
    expect(getIndexedKeyboardWorktree(withArchived, 1)?.worktreeId).toBe('first')
    expect(getIndexedKeyboardWorktree(withArchived, 4)).toBeNull()
  })

  it('follows the provided sidebar order and removes duplicate pinned rows', () => {
    const visible = [rows[2], rows[0], rows[2], rows[1]]

    expect(getRelativeKeyboardWorktree(visible, 'second', 1, 'provided')?.worktreeId).toBe('third')
    expect(getIndexedKeyboardWorktree(visible, 2, 'provided')?.worktreeId).toBe('third')
  })

  it('maintains a branching back and forward history', () => {
    const history = new MobileWorktreeNavigationHistory()
    history.record('one')
    history.record('two')
    history.record('three')
    expect(history.back()).toBe('two')
    expect(history.back()).toBe('one')
    expect(history.forward()).toBe('two')
    history.record('four')
    expect(history.forward()).toBeNull()
    expect(history.back()).toBe('two')
  })
})
