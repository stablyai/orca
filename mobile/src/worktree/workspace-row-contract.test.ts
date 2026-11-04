import { describe, expectTypeOf, it } from 'vitest'
import type { RuntimeWorktreePsSummary } from '../../../src/shared/runtime-types'
import type {
  FieldsRetypedByPhone,
  PhoneKeysTakenByDesktop
} from '../test-support/desktop-contract-type-checks'
import type { Worktree, WorktreeRowView } from './workspace-list-types'

describe('the phone workspace row against the desktop contract', () => {
  it('keeps phone-only list facts off the names the desktop row uses', () => {
    expectTypeOf<PhoneKeysTakenByDesktop<WorktreeRowView, RuntimeWorktreePsSummary>>().toBeNever()
  })

  it('accepts every value the desktop sends for a field the phone also names', () => {
    expectTypeOf<FieldsRetypedByPhone<RuntimeWorktreePsSummary, Worktree>>().toBeNever()
  })
})
