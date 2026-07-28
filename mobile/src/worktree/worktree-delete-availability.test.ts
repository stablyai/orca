import { describe, expect, it } from 'vitest'
import { canDeleteWorktreeFromMobile } from './worktree-delete-availability'

describe('canDeleteWorktreeFromMobile', () => {
  it('refuses the primary checkout, which git will not remove', () => {
    // Why (regression): the main worktree sorts first in every repo group and is shown by
    // default, so mobile offered a Delete that the runtime rejects with "Refusing to delete
    // protected worktree path" — a dead button on the most prominent row in the list.
    expect(canDeleteWorktreeFromMobile({ isMainWorktree: true })).toBe(false)
  })

  it('allows an ordinary worktree', () => {
    expect(canDeleteWorktreeFromMobile({ isMainWorktree: false })).toBe(true)
  })

  it('defers to the runtime when the host does not report isMainWorktree', () => {
    // Older hosts omit the field; guessing from the branch name would block deleting a
    // perfectly deletable worktree that merely sits on main.
    expect(canDeleteWorktreeFromMobile({})).toBe(true)
  })
})
