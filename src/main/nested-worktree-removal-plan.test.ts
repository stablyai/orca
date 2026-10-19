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
const sibling = worktree('/workspaces/parent-other')
const args = { repoPath: main.path, worktreePath: parent.path, home: CLIENT_REMOVAL_HOME }

describe('nested worktree removal plan', () => {
  it('uses Git registrations, orders deepest first and excludes siblings', () => {
    expect(
      getNestedWorktreeRemovalPlan({
        ...args,
        worktrees: [main, parent, child, sibling, grandchild]
      })
    ).toEqual([grandchild, child, parent])
  })

  it('handles Windows separators and case using the executing host home', () => {
    const windowsParent = worktree('C:\\workspaces\\Parent')
    const windowsChild = worktree('c:\\workspaces\\parent\\.tmp\\child')
    expect(
      getNestedWorktreeRemovalPlan({
        repoPath: 'C:\\repo',
        worktreePath: windowsParent.path,
        home: executionHostRemovalHome('C:\\Users\\developer'),
        worktrees: [windowsParent, windowsChild]
      })
    ).toEqual([windowsChild, windowsParent])
  })

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

  it('refuses a parent that is no longer registered', () => {
    expect(() => getNestedWorktreeRemovalPlan({ ...args, worktrees: [main, child] })).toThrow(
      /unregistered/
    )
  })

  it('accepts an unchanged confirmation independent of ordering', () => {
    expect(() =>
      assertNestedWorktreeRemovalApproval([child, parent], [parent, child])
    ).not.toThrow()
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
