import { describe, expect, it } from 'vitest'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import {
  getNestedWorktreeRemovalPlan,
  assertNestedWorktreeRemovalApproval
} from './nested-worktree-removal-plan'
import { CLIENT_REMOVAL_HOME, executionHostRemovalHome } from './worktree-removal-home-guard'

function worktree(path: string, isMainWorktree = false): GitWorktreeInfo {
  return { path, head: 'abc123', branch: path, isMainWorktree, isBare: false }
}

const main = worktree('/repo', true)
const parent = worktree('/workspaces/parent')
const child = worktree('/workspaces/parent/.tmp/child')
const grandchild = worktree('/workspaces/parent/.tmp/child/grandchild')
const args = { repoPath: main.path, worktreePath: parent.path, home: CLIENT_REMOVAL_HOME }

describe('nested worktree removal plan', () => {
  it.each([
    ['locked child', { ...child, locked: true }, /locked by Git/],
    ['main checkout inside parent', { ...child, isMainWorktree: true }, /protected worktree/]
  ])('refuses the whole plan for a %s', (_name, protectedChild, error) => {
    expect(() =>
      getNestedWorktreeRemovalPlan({ ...args, worktrees: [main, parent, protectedChild] })
    ).toThrow(error)
  })

  it('keeps main checkout and execution host home protected', () => {
    expect(() =>
      getNestedWorktreeRemovalPlan({ ...args, worktreePath: main.path, worktrees: [main] })
    ).toThrow(/protected/)
    expect(() =>
      getNestedWorktreeRemovalPlan({
        ...args,
        worktreePath: '/remote/home',
        home: executionHostRemovalHome('/remote/home'),
        worktrees: [worktree('/remote/home')]
      })
    ).toThrow(/protected/)
    expect(() =>
      getNestedWorktreeRemovalPlan({
        ...args,
        home: executionHostRemovalHome(null),
        worktrees: [parent, child]
      })
    ).toThrow(/protected/)
  })

  it.each([
    [child, parent, grandchild],
    [parent],
    [{ ...child, head: 'new-commit' }, parent],
    [{ ...child, branch: 'replacement-branch' }, parent],
    [parent, parent]
  ])('refuses a stale or incomplete confirmation: %j', (...approved) => {
    expect(() => assertNestedWorktreeRemovalApproval([child, parent], approved)).toThrow(/changed/)
  })
})
