import { describe, expectTypeOf, it } from 'vitest'
import type { RuntimeWorktreePsSummary } from '../../../src/shared/runtime-types'
import type { Worktree, WorktreeRowView } from './workspace-list-types'

// Keys the two sides share whose host value the phone's type would not accept.
type RedeclaredWithAnotherType<Host, Phone> = {
  [K in keyof Host & keyof Phone]-?: [NonNullable<Host[K]>] extends [NonNullable<Phone[K]>]
    ? never
    : K
}[keyof Host & keyof Phone]

describe('the phone workspace row against the desktop contract', () => {
  it('keeps phone-only list facts off the names the desktop row uses', () => {
    expectTypeOf<Extract<keyof WorktreeRowView, keyof RuntimeWorktreePsSummary>>().toBeNever()
    expectTypeOf<Extract<keyof WorktreeRowView, keyof Worktree>>().toBeNever()
  })

  it('accepts every value the desktop sends for a field the phone also names', () => {
    expectTypeOf<RedeclaredWithAnotherType<RuntimeWorktreePsSummary, Worktree>>().toBeNever()
  })
})
