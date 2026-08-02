import { describe, expect, it } from 'vitest'
import { resolveNewWorktreeFormSheetVisible } from './new-worktree-form-sheet-visibility'

describe('resolveNewWorktreeFormSheetVisible', () => {
  it('keeps the form under the source picker and its close transition', () => {
    expect(
      resolveNewWorktreeFormSheetVisible({
        modalVisible: true,
        drawerView: 'source',
        formPinnedUnderSource: true
      })
    ).toBe(true)
    expect(
      resolveNewWorktreeFormSheetVisible({
        modalVisible: true,
        drawerView: 'transition',
        formPinnedUnderSource: true
      })
    ).toBe(true)
  })

  it('hides the form for sequential repo/agent transitions', () => {
    expect(
      resolveNewWorktreeFormSheetVisible({
        modalVisible: true,
        drawerView: 'transition',
        formPinnedUnderSource: false
      })
    ).toBe(false)
    expect(
      resolveNewWorktreeFormSheetVisible({
        modalVisible: true,
        drawerView: 'repo',
        formPinnedUnderSource: false
      })
    ).toBe(false)
  })
})
